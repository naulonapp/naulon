<?php
/**
 * The self-test that decides whether this site can toll files.
 *
 * Writing a rewrite rule proves nothing: nginx ignores `.htaccess`, a host can disable overrides,
 * a CDN can answer from cache, and a media plugin can serve uploads from another host. So the
 * plugin asks its own public URL for a probe file, the way a crawler would, and counts the route
 * as working only when the reply echoes a nonce minted for that one request. A cache can replay a
 * reply; it cannot replay one carrying a nonce that did not exist when the reply was stored.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_File_Probe {

	/** The probe directory under uploads; always routed, so the test can run before any type is opted in. */
	const DIR = 'naulon-probe';

	/** The probe file. */
	const FILE = 'probe.pdf';

	/** The request header carrying a nonce, and the response header echoing it. */
	const REQUEST_HEADER  = 'X-Naulon-Probe';
	const RESPONSE_HEADER = 'X-Naulon-File';

	/** Live nonces, newest last. */
	const NONCE_TRANSIENT = 'naulon_file_probe_nonces';
	const NONCE_TTL       = 300;
	const NONCE_KEEP      = 12;

	/** The stored result of the last run. */
	const OPTION = 'naulon_file_probe';

	/** How often the cron re-runs it. */
	const MAX_AGE = 86400;

	/** The closed set of verdicts, shared word for word with the control plane. */
	const STATUSES = array( 'ok', 'no_rewrite', 'not_writable', 'cached', 'offloaded', 'unsupported' );

	/** A minimal valid PDF: the probe must be a real file of a routed type. */
	const PROBE_BYTES = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

	/** @var Naulon_File_Probe|null */
	private static $instance = null;

	/**
	 * @return Naulon_File_Probe
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Mint a nonce for one probe request.
	 *
	 * @return string
	 */
	public function issue_nonce() {
		$nonce  = wp_generate_password( 24, false );
		$nonces = get_transient( self::NONCE_TRANSIENT );
		$nonces = is_array( $nonces ) ? $nonces : array();
		$nonces[] = $nonce;
		set_transient( self::NONCE_TRANSIENT, array_slice( $nonces, -self::NONCE_KEEP ), self::NONCE_TTL );
		return $nonce;
	}

	/**
	 * Was this nonce minted here in the last few minutes?
	 *
	 * @param string $nonce From the request header.
	 * @return bool
	 */
	public function nonce_valid( $nonce ) {
		if ( ! is_string( $nonce ) || '' === $nonce ) {
			return false;
		}
		$nonces = get_transient( self::NONCE_TRANSIENT );
		return is_array( $nonces ) && in_array( $nonce, $nonces, true );
	}

	/**
	 * Hook into WordPress: re-test after the route follows a new opted-in set.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'naulon_file_types_changed', array( $this, 'run_and_report' ), 20, 0 );
	}

	/**
	 * The verdict from the site's shape and three probe replies.
	 *
	 * Each reply is {code, sent, echo, cache}: the HTTP status (0 on a transport error), the nonce
	 * sent, the nonce echoed back or null, and a cache name read off the response headers.
	 *
	 * @param array      $env {multisite, offloaded, written}.
	 * @param array|null $a   Cache-busted request.
	 * @param array|null $b1  First repeat.
	 * @param array|null $b2  Second repeat.
	 * @return array {status, detail}
	 */
	public static function classify( array $env, $a, $b1, $b2 ) {
		if ( $env['multisite'] ) {
			return self::verdict( 'unsupported', 'multisite networks are not supported yet' );
		}
		if ( $env['offloaded'] ) {
			return self::verdict( 'offloaded', '' );
		}
		if ( ! is_array( $a ) || 0 === $a['code'] ) {
			return self::verdict( 'unsupported', 'this site could not reach its own address' );
		}
		if ( 401 === $a['code'] || 403 === $a['code'] ) {
			return self::verdict( 'unsupported', sprintf( 'this site answered its own request with HTTP %d', $a['code'] ) );
		}
		if ( $a['echo'] !== $a['sent'] ) {
			return self::verdict( $env['written'] ? 'no_rewrite' : 'not_writable', '' );
		}
		if ( ! is_array( $b2 ) || $b2['echo'] !== $b2['sent'] ) {
			$cache = is_array( $b2 ) ? $b2['cache'] : '';
			return self::verdict( 'cached', '' === $cache ? 'a cache in front of your site' : $cache );
		}
		return self::verdict( 'ok', '' );
	}

	/**
	 * @param string $status One of STATUSES.
	 * @param string $detail Plain words for the screen.
	 * @return array
	 */
	private static function verdict( $status, $detail ) {
		return array(
			'status' => $status,
			'detail' => $detail,
		);
	}

	/**
	 * The `x-naulon-file-toll` value for a stored result, or '' when it never ran.
	 *
	 * @param array|null $result A stored result.
	 * @return string
	 */
	public static function header_for( $result ) {
		if ( ! is_array( $result ) || ! isset( $result['status'], $result['types'], $result['at'] ) || ! in_array( $result['status'], self::STATUSES, true ) ) {
			return '';
		}
		return $result['status'] . '; types=' . implode( ',', $result['types'] ) . '; at=' . (int) $result['at'];
	}

	/**
	 * Name the cache a response came from, from its headers.
	 *
	 * @param array $headers Lowercased header names to values.
	 * @return string
	 */
	public static function cache_name( array $headers ) {
		if ( ! empty( $headers['cf-cache-status'] ) ) {
			return 'Cloudflare (' . $headers['cf-cache-status'] . ')';
		}
		if ( ! empty( $headers['x-litespeed-cache'] ) ) {
			return 'LiteSpeed (' . $headers['x-litespeed-cache'] . ')';
		}
		if ( ! empty( $headers['x-cache'] ) ) {
			return 'a cache (' . $headers['x-cache'] . ')';
		}
		return '';
	}

	/**
	 * The last result, or null.
	 *
	 * @return array|null {status, types, at, detail}
	 */
	public function last() {
		$stored = get_option( self::OPTION );
		return is_array( $stored ) && isset( $stored['status'] ) ? $stored : null;
	}

	/**
	 * Is the stored result older than MAX_AGE (or missing)?
	 *
	 * @return bool
	 */
	public function is_stale() {
		$last = $this->last();
		return null === $last || ( time() - (int) $last['at'] ) > self::MAX_AGE;
	}

	/**
	 * Run the test and store the result.
	 *
	 * @return array {status, types, at, detail}
	 */
	public function run() {
		$env = array(
			'multisite' => is_multisite(),
			'offloaded' => null === Naulon_File_Route::uploads_rel(),
			'written'   => ! empty( Naulon_File_Route::instance()->current() ),
		);
		$a  = null;
		$b1 = null;
		$b2 = null;
		if ( ! $env['multisite'] && ! $env['offloaded'] ) {
			$url = $this->ensure_probe_file();
			if ( '' === $url ) {
				return $this->store( self::verdict( 'unsupported', 'the probe file could not be written to the uploads folder' ) );
			}
			$a  = $this->request( add_query_arg( 'n', wp_generate_password( 12, false ), $url ) );
			$b1 = $this->request( $url );
			$b2 = $this->request( $url );
		}
		return $this->store( self::classify( $env, $a, $b1, $b2 ) );
	}

	/**
	 * Run, then tell the control plane at once, so the portal does not wait for the hourly fetch.
	 *
	 * @return array
	 */
	public function run_and_report() {
		$result = $this->run();
		Naulon_Client::instance()->enforce_config( home_url( '/' ) );
		return $result;
	}

	/**
	 * @param array $verdict {status, detail}.
	 * @return array
	 */
	private function store( array $verdict ) {
		$result = array(
			'status' => $verdict['status'],
			'detail' => $verdict['detail'],
			'types'  => Naulon_Rules::instance()->file_types(),
			'at'     => time(),
		);
		update_option( self::OPTION, $result, false );
		return $result;
	}

	/**
	 * One probe request with a fresh nonce.
	 *
	 * @param string $url Public probe URL.
	 * @return array {code, sent, echo, cache}
	 */
	private function request( $url ) {
		$nonce    = $this->issue_nonce();
		$response = wp_remote_get(
			$url,
			array(
				'timeout'     => 5,
				'redirection' => 2,
				'headers'     => array( self::REQUEST_HEADER => $nonce ),
				/** This filter is documented in wp-includes/class-wp-http-streams.php */
				'sslverify'   => apply_filters( 'https_local_ssl_verify', false ),
			)
		);
		if ( is_wp_error( $response ) ) {
			return array(
				'code'  => 0,
				'sent'  => $nonce,
				'echo'  => null,
				'cache' => '',
			);
		}
		$echo = null;
		$line = (string) wp_remote_retrieve_header( $response, strtolower( self::RESPONSE_HEADER ) );
		if ( preg_match( '/^routed; n=([A-Za-z0-9]+)$/', trim( $line ), $m ) ) {
			$echo = $m[1];
		}
		$headers = array();
		foreach ( array( 'cf-cache-status', 'x-litespeed-cache', 'x-cache' ) as $name ) {
			$headers[ $name ] = (string) wp_remote_retrieve_header( $response, $name );
		}
		return array(
			'code'  => (int) wp_remote_retrieve_response_code( $response ),
			'sent'  => $nonce,
			'echo'  => $echo,
			'cache' => self::cache_name( $headers ),
		);
	}

	/**
	 * Write the probe file if it is missing, and return its public URL ('' on failure).
	 *
	 * @return string
	 */
	private function ensure_probe_file() {
		$uploads = wp_upload_dir( null, false );
		$dir     = trailingslashit( $uploads['basedir'] ) . self::DIR;
		$path    = $dir . '/' . self::FILE;
		if ( ! file_exists( $path ) ) {
			global $wp_filesystem;
			if ( ! function_exists( 'WP_Filesystem' ) ) {
				require_once ABSPATH . 'wp-admin/includes/file.php';
			}
			if ( ! WP_Filesystem() || ! is_object( $wp_filesystem ) ) {
				return '';
			}
			if ( ! $wp_filesystem->is_dir( $dir ) && ! $wp_filesystem->mkdir( $dir ) ) {
				return '';
			}
			if ( ! $wp_filesystem->put_contents( $path, self::PROBE_BYTES, FS_CHMOD_FILE ) ) {
				return '';
			}
		}
		return trailingslashit( $uploads['baseurl'] ) . self::DIR . '/' . self::FILE;
	}

	/**
	 * Remove the probe file and its directory. Called on uninstall.
	 *
	 * @return void
	 */
	public function cleanup() {
		$dir  = trailingslashit( wp_upload_dir( null, false )['basedir'] ) . self::DIR;
		$path = $dir . '/' . self::FILE;
		if ( file_exists( $path ) ) {
			wp_delete_file_from_directory( $path, $dir );
		}
		if ( is_dir( $dir ) ) {
			global $wp_filesystem;
			if ( ! function_exists( 'WP_Filesystem' ) ) {
				require_once ABSPATH . 'wp-admin/includes/file.php';
			}
			if ( WP_Filesystem() && is_object( $wp_filesystem ) ) {
				$wp_filesystem->rmdir( $dir );
			}
		}
		delete_option( self::OPTION );
	}
}
