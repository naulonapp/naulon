<?php
/**
 * Connect: this site asks its gate for its own credential, and its owner approves on the gate.
 *
 * The protocol is docs/protocol/in-app.md. The plugin starts the request (`start`), answers the
 * gate's two questions while the request is pending (the challenge for its `state`, and the client
 * document at /.well-known/naulon-client, served by Naulon_Challenge), takes the owner's return on
 * its own Setup screen (`finish`), and exchanges the code for an `nln_site_` credential. Approving
 * a connect proves the domain, so Setup's ownership step is done with it.
 *
 * Pending connects are rows in wp_options, one per state, never autoloaded. `take` deletes the row
 * and only the request whose delete removed it proceeds, so a refreshed return page cannot exchange a
 * code twice (the gate revokes the credential if it sees that).
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Connect {

	/** Option name prefix for a pending connect; the rest is a digest of its state. */
	const PENDING_PREFIX = 'naulon_cpend_';

	/** A pending connect lives as long as an owner might take to read the page and sign in. */
	const PENDING_TTL = 900;

	/** Naulon_Admin::PAGE_SETUP, which must stay equal to it. */
	const SETUP_PAGE = 'naulon';

	/** The query arg that marks the owner's return on the Setup screen. */
	const RETURN_ARG = 'connect';

	/** What the owner reads on the approve page as the name of what is asking. */
	public static function client_name() {
		return 'naulon for WordPress';
	}

	/** This site, as connect names it: an origin, nothing after it. Null when WordPress is not at one. */
	public static function site() {
		return Naulon_Connect_Protocol::site_origin( home_url( '/' ) );
	}

	/** The client's id: its own metadata document, served from this site. */
	public static function client_id() {
		$site = self::site();
		return null === $site ? '' : $site . Naulon_Connect_Protocol::CLIENT_PATH;
	}

	/** Where the gate sends the owner back: this plugin's Setup screen. */
	public static function redirect_uri() {
		// The Setup screen's slug, spelled out: the client document is served on the front end, where
		// Naulon_Admin (which owns PAGE_SETUP) is never loaded.
		return admin_url( 'admin.php?page=' . self::SETUP_PAGE . '&' . self::RETURN_ARG . '=return' );
	}

	/**
	 * The client metadata document. A redirect is allowed only on this site's own origin, so a
	 * WordPress whose admin lives on another origin than its home cannot connect, and says so.
	 *
	 * @return array|null
	 */
	public static function client_document() {
		$site = self::site();
		if ( null === $site || Naulon_Connect_Protocol::origin_of( self::redirect_uri() ) !== $site ) {
			return null;
		}
		return array(
			'client_id'                  => self::client_id(),
			'client_name'                => self::client_name(),
			'redirect_uris'              => array( self::redirect_uri() ),
			'token_endpoint_auth_method' => 'none',
			'grant_types'                => array( 'authorization_code' ),
		);
	}

	/**
	 * A gate's discovery document, or why there is none.
	 *
	 * @param string $gate The gate's URL.
	 * @return array|string
	 */
	public static function discover( $gate ) {
		$origin = Naulon_Connect_Protocol::origin_of( (string) $gate );
		if ( null === $origin ) {
			return __( 'A gate address starts with https://.', 'naulon' );
		}
		$res = self::http( 'GET', $origin . Naulon_Connect_Protocol::DISCOVERY_PATH, $origin );
		if ( is_wp_error( $res ) ) {
			/* translators: 1: gate origin, 2: transport error. */
			return sprintf( __( '%1$s could not be reached: %2$s', 'naulon' ), $origin, $res->get_error_message() );
		}
		$status = (int) wp_remote_retrieve_response_code( $res );
		if ( 200 !== $status ) {
			/* translators: 1: gate origin, 2: HTTP status. */
			return sprintf( __( '%1$s is not a naulon gate (it answered %2$d).', 'naulon' ), $origin, $status );
		}
		$doc = Naulon_Connect_Protocol::parse_discovery( json_decode( wp_remote_retrieve_body( $res ), true ), $origin );
		if ( is_string( $doc ) ) {
			/* translators: 1: gate origin, 2: what is wrong with its document. */
			return sprintf( __( '%1$s is not a naulon gate: %2$s', 'naulon' ), $origin, $doc );
		}
		return $doc;
	}

	/**
	 * Begin a connect for the signed-in user. Returns the gate's approve page to send them to.
	 *
	 * @param string $gate    The gate's URL.
	 * @param int    $user_id Whose connect this is: only they may finish it.
	 * @return string|WP_Error
	 */
	public static function start( $gate, $user_id ) {
		$site = self::site();
		if ( null === $site || null === self::client_document() ) {
			return new WP_Error( 'naulon_site', __( 'This site cannot connect: WordPress must answer at its own https address, with its admin on that same address.', 'naulon' ) );
		}
		$doc = self::discover( $gate );
		if ( is_string( $doc ) ) {
			return new WP_Error( 'naulon_gate', $doc );
		}
		self::sweep();
		self::ensure_client_route();
		$state    = Naulon_Connect_Protocol::random( 24 );
		$verifier = Naulon_Connect_Protocol::random( 32 );
		$pending  = array(
			'gate'       => $doc['issuer'],
			'token'      => $doc['token_endpoint'],
			'revocation' => $doc['revocation_endpoint'],
			'verifier'   => $verifier,
			'challenge'  => Naulon_Connect_Protocol::code_challenge( $verifier ),
			'user'       => (int) $user_id,
			'expires'    => time() + self::PENDING_TTL,
		);
		add_option( self::option( $state ), $pending, '', false );
		return add_query_arg(
			rawurlencode_deep(
				array(
					'response_type'         => 'code',
					'client_id'             => self::client_id(),
					'redirect_uri'          => self::redirect_uri(),
					'scope'                 => Naulon_Connect_Protocol::SITE_SCOPE,
					'site'                  => $site,
					'state'                 => $state,
					'code_challenge'        => $pending['challenge'],
					'code_challenge_method' => 'S256',
				)
			),
			$doc['authorization_endpoint']
		);
	}

	/**
	 * What to answer at /.well-known/naulon-challenge/<state>: the pending connect's challenge, or null
	 * for a state this site never started, which is answered like a page that does not exist.
	 *
	 * @param string $state The path segment asked for.
	 * @return string|null
	 */
	public static function challenge_for( $state ) {
		$pending = self::pending( $state );
		return null === $pending ? null : $pending['challenge'];
	}

	/**
	 * The owner is back. Check, in the protocol's order, then exchange the code.
	 *
	 * @param array $query   The return's query string.
	 * @param int   $user_id The signed-in user.
	 * @return array{ok: bool, gate?: string, credential?: string, error?: string, message?: string}
	 */
	public static function finish( array $query, $user_id ) {
		$state   = isset( $query['state'] ) ? (string) $query['state'] : '';
		$pending = self::pending( $state );
		if ( null === $pending || (int) $pending['user'] !== (int) $user_id ) {
			return self::failed( 'expired', __( 'This connect expired, was already finished, or was started by someone else. Start it again.', 'naulon' ) );
		}
		// RFC 9207: a response naming another gate, or none, is a mix-up. The pending connect is kept.
		if ( ! isset( $query['iss'] ) || (string) $query['iss'] !== $pending['gate'] ) {
			return self::failed( 'mixup', __( 'The answer did not come from the gate this connect started with, so nothing was changed.', 'naulon' ) );
		}
		$pending = self::take( $state );
		if ( null === $pending ) {
			return self::failed( 'expired', __( 'This connect was already finished.', 'naulon' ) );
		}
		if ( isset( $query['error'] ) ) {
			return self::failed( 'denied', __( 'The connect was not approved. Nothing was changed.', 'naulon' ) );
		}
		$code = isset( $query['code'] ) ? (string) $query['code'] : '';
		if ( '' === $code ) {
			return self::failed( 'invalid', __( 'The gate sent no code back. Start the connect again.', 'naulon' ) );
		}

		$res = self::http(
			'POST',
			$pending['token'],
			$pending['gate'],
			array(
				'grant_type'    => 'authorization_code',
				'code'          => $code,
				'code_verifier' => $pending['verifier'],
				'redirect_uri'  => self::redirect_uri(),
				'client_id'     => self::client_id(),
			)
		);
		$status = is_wp_error( $res ) ? 0 : (int) wp_remote_retrieve_response_code( $res );
		if ( 0 === $status || $status >= 500 ) {
			// The gate never answered: put the connect back, so the owner can retry from the same link.
			add_option( self::option( $state ), $pending, '', false );
			return self::failed( 'unreachable', __( 'The gate could not be reached to finish the connect. Reload this page to try again.', 'naulon' ) );
		}
		$body = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( 200 !== $status || ! is_array( $body ) ) {
			$why = is_array( $body ) && isset( $body['error_description'] ) && is_string( $body['error_description'] ) ? $body['error_description'] : (string) $status;
			/* translators: %s: the gate's reason. */
			return self::failed( 'refused', sprintf( __( 'The gate refused the connect: %s', 'naulon' ), $why ) );
		}
		$credential = isset( $body['access_token'] ) && is_string( $body['access_token'] ) ? $body['access_token'] : '';
		if ( ! Naulon_Connect_Protocol::is_site_credential( $credential ) ) {
			return self::failed( 'refused', __( 'The gate returned no site credential.', 'naulon' ) );
		}
		if ( ! isset( $body['site'] ) || $body['site'] !== self::site() ) {
			return self::failed( 'refused', __( 'The gate returned a credential for something else.', 'naulon' ) );
		}
		return array(
			'ok'         => true,
			'gate'       => $pending['gate'],
			'credential' => $credential,
		);
	}

	/**
	 * End a credential on its gate (RFC 7009). Best effort: the gate answers 200 whether or not it
	 * existed, and a gate that cannot be reached is reported, not retried.
	 *
	 * @param string $gate       The gate the credential is for.
	 * @param string $credential The credential.
	 * @return bool Whether the gate confirmed it.
	 */
	public static function revoke( $gate, $credential ) {
		if ( ! Naulon_Connect_Protocol::is_site_credential( $credential ) ) {
			return true;
		}
		$doc = self::discover( $gate );
		if ( is_string( $doc ) ) {
			return false;
		}
		$res = self::http( 'POST', $doc['revocation_endpoint'], $doc['issuer'], array( 'token' => $credential ) );
		return ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res );
	}

	/**
	 * Drop pending connects past their deadline. Run where they are made.
	 *
	 * @return int How many went.
	 */
	public static function sweep() {
		global $wpdb;
		$names = $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like( self::PENDING_PREFIX ) . '%' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$gone  = 0;
		foreach ( $names as $name ) {
			$p = get_option( $name );
			if ( ! is_array( $p ) || ! isset( $p['expires'] ) || (int) $p['expires'] <= time() ) {
				delete_option( $name );
				$gone++;
			}
		}
		return $gone;
	}

	/**
	 * Drop every pending connect, finished or not. For uninstall.
	 *
	 * @return void
	 */
	public static function forget_pending() {
		global $wpdb;
		$names = $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like( self::PENDING_PREFIX ) . '%' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		foreach ( $names as $name ) {
			delete_option( $name );
		}
	}

	/* ------------------------------------------------------------------------------------------- */

	/**
	 * A site that upgraded into this version never re-activated, so WordPress has not written the
	 * client document's rewrite rule and the gate would get a 404 for it. Flush once, the first time
	 * a connect starts; after that the rule is in the stored set and this is one array lookup.
	 *
	 * @return void
	 */
	private static function ensure_client_route() {
		$rules = get_option( 'rewrite_rules' );
		if ( is_array( $rules ) && isset( $rules['^\.well-known/naulon-client/?$'] ) ) {
			return;
		}
		Naulon_Challenge::instance()->add_rewrite_rules();
		flush_rewrite_rules( false );
	}

	/**
	 * @param string $state A state.
	 * @return string
	 */
	private static function option( $state ) {
		return self::PENDING_PREFIX . substr( hash( 'sha256', $state ), 0, 40 );
	}

	/**
	 * @param string $state A state.
	 * @return array|null
	 */
	private static function pending( $state ) {
		if ( ! is_string( $state ) || 1 !== preg_match( Naulon_Connect_Protocol::STATE_PATTERN, $state ) ) {
			return null;
		}
		$p = get_option( self::option( $state ) );
		if ( ! is_array( $p ) || ! isset( $p['expires'] ) || (int) $p['expires'] <= time() ) {
			return null;
		}
		return $p;
	}

	/**
	 * Read and delete: only the request whose delete removed the row gets it.
	 *
	 * @param string $state A state.
	 * @return array|null
	 */
	private static function take( $state ) {
		$p = self::pending( $state );
		if ( null === $p ) {
			return null;
		}
		return delete_option( self::option( $state ) ) ? $p : null;
	}

	/**
	 * @param string $error   A short code.
	 * @param string $message What the owner reads.
	 * @return array
	 */
	private static function failed( $error, $message ) {
		return array(
			'ok'      => false,
			'error'   => $error,
			'message' => $message,
		);
	}

	/**
	 * One request to a gate: no redirects followed, a short deadline, a body cap, and never a private
	 * address unless the gate is on this machine and WordPress says this is a local install.
	 *
	 * @param string     $method GET or POST.
	 * @param string     $url    Where.
	 * @param string     $gate   The gate's origin.
	 * @param array|null $form   A form body, for POST.
	 * @return array|WP_Error
	 */
	private static function http( $method, $url, $gate, $form = null ) {
		$args = array(
			'method'              => $method,
			'timeout'             => 10,
			'redirection'         => 0,
			'limit_response_size' => 65536,
			'headers'             => array( 'Accept' => 'application/json' ),
		);
		if ( null !== $form ) {
			$args['headers']['Content-Type'] = 'application/x-www-form-urlencoded';
			$args['body']                    = http_build_query( $form, '', '&', PHP_QUERY_RFC3986 );
		}
		$host  = (string) wp_parse_url( $gate, PHP_URL_HOST );
		$local = Naulon_Connect_Protocol::is_loopback( $host ) && 'local' === wp_get_environment_type();
		return $local ? wp_remote_request( $url, $args ) : wp_safe_remote_request( $url, $args );
	}
}
