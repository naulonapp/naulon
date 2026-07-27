<?php
/**
 * The toll itself — the decision path, in the order it must run.
 *
 *   1. human                    → serve normally, always, forever
 *   2. licensed re-read         → serve free (already paid for this)
 *   3. payment presented        → settle, then serve + receipt + license
 *   4. agent, no payment        → 402 with the price
 *
 * What is decided HERE: is this an agent, is this an article, is this the site's own front end
 * calling itself. What is decided by the control plane: the price, the 402 bytes, the
 * settlement, and whether a license is valid. That split is deliberate — see Naulon_Agent and
 * Naulon_Client for why each piece sits where it does.
 *
 * Two properties are non-negotiable and shape everything below:
 *
 * **A human is never touched.** Classification happens before any network call, and a human
 * verdict returns immediately. No reader ever waits on the control plane.
 *
 * **The site never breaks.** Every remote failure has an explicit posture, and the default is
 * to serve. A plugin that 402s a real reader — or white-screens because an API was slow — gets
 * uninstalled and never reinstalled, and then the publisher earns nothing at all. Serving a
 * crawler free is a lost micro-toll; that is the cheap direction and we take it every time.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Enforcer {

	/** The agent's payment, presented on the retry after a 402. */
	const PAYMENT_HEADER = 'PAYMENT-SIGNATURE';

	/** Our price, returned with the 402. */
	const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';

	/** The settlement receipt, returned with the paid content. */
	const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

	/** The re-read license, returned with the paid content. */
	const LICENSE_HEADER = 'X-Naulon-License';

	/** The holder-of-key proof, forwarded to the control plane when present. */
	const PROOF_HEADER = 'X-Naulon-Proof';

	/** How long a built 402 is reused. In gateway mode a 402 carries no nonce, so it is
	 *  identical for every caller asking about the same resource — a crawler flood is served
	 *  from here at no marginal cost. Short enough that a price change lands quickly. */
	const QUOTE_TTL = 300;

	/** @var Naulon_Enforcer|null */
	private static $instance = null;

	/** @var array|null Memoized decision for this request. */
	private $decision = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function register() {
		// Early enough to answer before the theme renders anything, late enough that the query
		// is parsed and we know which post was asked for.
		add_action( 'template_redirect', array( $this, 'guard_article' ), 1 );
		// The REST content route hands out the same article through a different door.
		add_filter( 'rest_pre_dispatch', array( $this, 'guard_rest' ), 10, 3 );
		// Full-text feeds are the third door.
		add_action( 'template_redirect', array( $this, 'guard_feed' ), 2 );
	}

	/**
	 * Is enforcement switched on and safe to run at all?
	 *
	 * Verification is a hard prerequisite, not a nicety: without a proven ownership challenge
	 * the control plane refuses to settle for this host, so a 402 we issued could never be
	 * completed. Issuing a price we cannot honor is worse than serving free.
	 *
	 * @return bool
	 */
	public function is_active() {
		$settings = Naulon_Settings::all();
		if ( empty( $settings['enforcement_on'] ) ) {
			return false;
		}
		if ( ! Naulon_Settings::is_connected() || ! Naulon_Settings::is_verified() ) {
			return false;
		}
		// A CNAME to the fleet plus in-app enforcement would toll the same read twice. When the
		// control plane has classified this host as a conflict, we stand down and let the gate
		// do it — surfaced in admin, never silently.
		return 'conflict' !== $this->cached_enforcement_mode();
	}

	/**
	 * The HTML door.
	 *
	 * @return void
	 */
	public function guard_article() {
		if ( is_feed() || ! is_singular() ) {
			return;
		}
		$post = get_queried_object();
		if ( ! $post instanceof WP_Post ) {
			return;
		}
		$this->enforce( $post );
	}

	/**
	 * The feed door — full-text feeds hand out the whole article.
	 *
	 * @return void
	 */
	public function guard_feed() {
		if ( ! is_feed() ) {
			return;
		}
		// A feed is a list, not one article, and summaries are the free discovery plane. Only a
		// full-text feed is a tolled surface; excerpt feeds stay free so agents can still find
		// the work they might pay for.
		if ( ! get_option( 'rss_use_excerpt' ) && is_singular() ) {
			$post = get_queried_object();
			if ( $post instanceof WP_Post ) {
				$this->enforce( $post );
			}
		}
	}

	/**
	 * The REST door. Returning a WP_REST_Response here short-circuits the dispatch.
	 *
	 * @param mixed           $result  Existing short-circuit, if any.
	 * @param WP_REST_Server  $server  The server.
	 * @param WP_REST_Request $request The request.
	 * @return mixed
	 */
	public function guard_rest( $result, $server, $request ) {
		if ( null !== $result ) {
			return $result;
		}
		$route = (string) $request->get_route();
		if ( 1 !== preg_match( '#^/wp/v2/(posts|pages)/(\d+)$#', $route, $m ) ) {
			return $result;
		}
		$post = get_post( (int) $m[2] );
		if ( ! $post instanceof WP_Post ) {
			return $result;
		}

		$decision = $this->decide( $post );
		if ( 'pay' !== $decision['action'] ) {
			return $result;
		}

		$response = new WP_REST_Response( array( 'code' => 'naulon_payment_required' ), 402 );
		$response->header( self::PAYMENT_REQUIRED_HEADER, $decision['header'] );
		$response->header( 'Cache-Control', 'private, no-store' );
		return $response;
	}

	/**
	 * Run the decision for a post and act on it. Only reached for a real article request.
	 *
	 * @param WP_Post $post The post.
	 * @return void
	 */
	private function enforce( $post ) {
		$decision = $this->decide( $post );

		if ( 'pay' === $decision['action'] ) {
			$this->send_402( $decision );
			return;
		}
		if ( 'settled' === $decision['action'] ) {
			// Paid. Serve the article, with the receipt and the license the agent will present
			// next time instead of paying again.
			$this->no_store();
			if ( '' !== $decision['receipt'] ) {
				header( self::PAYMENT_RESPONSE_HEADER . ': ' . $decision['receipt'] );
			}
			if ( '' !== $decision['license'] ) {
				header( self::LICENSE_HEADER . ': ' . $decision['license'] );
			}
			return;
		}
		if ( 'reread' === $decision['action'] ) {
			$this->no_store();
			return;
		}
		// 'free' — a human, a non-article, an unpriced resource, or a degraded control plane.
	}

	/**
	 * The decision. Pure-ish: it reads the request and may call the control plane, but it never
	 * writes a response. Memoized per request so the HTML and feed guards cannot double-settle.
	 *
	 * @param WP_Post $post The post.
	 * @return array {action: free|pay|settled|reread, header, receipt, license, reason}
	 */
	public function decide( $post ) {
		if ( null !== $this->decision ) {
			return $this->decision;
		}
		$this->decision = $this->compute_decision( $post );
		return $this->decision;
	}

	/**
	 * Record a decision in the diagnostics window and return it unchanged.
	 *
	 * Only ever called on a path where the requester was already classified as a machine —
	 * humans are not logged at all, anywhere. See Naulon_Log for why that is a position rather
	 * than an omission.
	 *
	 * @param array   $decision The decision.
	 * @param WP_Post $post     The post.
	 * @param string  $slug     Canonical slug.
	 * @return array The decision.
	 */
	private function logged( array $decision, $post, $slug ) {
		Naulon_Log::record(
			array(
				'action' => $decision['action'],
				'reason' => $decision['reason'],
				'slug'   => $slug,
				'kind'   => $this->requested_kind(),
				'ua'     => $this->header( 'User-Agent' ),
			)
		);
		return $decision;
	}

	/**
	 * @param WP_Post $post The post.
	 * @return array
	 */
	private function compute_decision( $post ) {
		if ( ! $this->is_active() ) {
			return $this->free( 'enforcement inactive' );
		}
		// The site's own front end calls wp-json constantly. Tolling that would 402 the editor
		// the publisher is looking at, which is the fastest possible way to get uninstalled.
		if ( $this->is_first_party() ) {
			return $this->free( 'first-party request' );
		}
		// Classification runs BEFORE the tollable check, and the order matters for two reasons.
		// A human verdict returns here having touched no database beyond the post already loaded
		// and having written nothing — which is the promise. And everything past this line is
		// known to be a machine, so it can be recorded in the diagnostics window without ever
		// logging a reader.
		$verdict = Naulon_Agent::classify( Naulon_Agent::signals_from_request(), $this->policy() );
		if ( 'human' === $verdict['kind'] ) {
			return $this->free( 'human (' . $verdict['reason'] . ')' );
		}

		// Only a tollable article is ever gated — the same predicate the credits contract uses,
		// so what is priced and what is payable can never disagree.
		$credits = Naulon_Credits::instance();
		if ( ! $credits->is_tollable( $post ) || empty( $credits->contributors_for( $post ) ) ) {
			return $this->logged(
				$this->free( 'not tollable (no wallet, unpublished, or opted out)' ),
				$post,
				$credits->canonical_slug_for( $post )
			);
		}

		$slug     = $credits->canonical_slug_for( $post );
		$resource = get_permalink( $post );
		$kind     = $this->requested_kind();

		// Already paid for this exact article? Verified by the control plane, which owns the
		// keys and the rules. A failure here falls through to the 402 — never serve on an
		// unverified claim, or the license header becomes a free-read password.
		$license = $this->header( self::LICENSE_HEADER );
		if ( '' !== $license ) {
			$checked = Naulon_Client::instance()->license_check( $license, $resource, $slug, $kind, $this->header( self::PROOF_HEADER ) );
			if ( $checked['ok'] && ! empty( $checked['body']['entitled'] ) ) {
				return $this->logged(
					array(
						'action'  => 'reread',
						'header'  => '',
						'receipt' => '',
						'license' => '',
						'reason'  => 'valid license',
					),
					$post,
					$slug
				);
			}
		}

		$built = $this->built_402( $resource, $slug, $kind );
		if ( null === $built ) {
			// No price (free article), or the control plane is unreachable. Either way: serve.
			return $this->logged( $this->free( 'no quote available' ), $post, $slug );
		}

		$payment = $this->header( self::PAYMENT_HEADER );
		if ( '' === $payment ) {
			return $this->logged(
				array(
					'action'  => 'pay',
					'header'  => $built['header'],
					'receipt' => '',
					'license' => '',
					'reason'  => 'agent (' . $verdict['reason'] . ')',
				),
				$post,
				$slug
			);
		}

		// Payment presented — settle it. Everything about moving money happens on the other
		// side of this call; we hand back the legs and quote we were given and are told what
		// happened.
		$settled = Naulon_Client::instance()->settle( $payment, $built['legs'], $built['quote'], $resource );
		if ( $settled['ok'] && ! empty( $settled['body']['ok'] ) ) {
			// Write the earnings record before returning. The amounts stored are the ones the
			// control plane put in the 402 the buyer signed — copied, never recomputed.
			Naulon_Ledger::record(
				array(
					'post_id'        => (int) $post->ID,
					'slug'           => $slug,
					'kind'           => $kind,
					'settlement_ref' => isset( $settled['body']['settlementRef'] ) ? (string) $settled['body']['settlementRef'] : '',
					'payer'          => isset( $settled['body']['payer'] ) ? (string) $settled['body']['payer'] : '',
					'legs'           => $built['legs'],
					'mode'           => Naulon_Ledger::mode_from_header( $built['header'] ),
				)
			);

			return $this->logged(
				array(
					'action'  => 'settled',
					'header'  => '',
					'receipt' => isset( $settled['body']['responseHeader'] ) ? (string) $settled['body']['responseHeader'] : '',
					'license' => isset( $settled['body']['licenseJws'] ) ? (string) $settled['body']['licenseJws'] : '',
					'reason'  => 'settled',
				),
				$post,
				$slug
			);
		}

		// Settlement failed. Re-present the price rather than serving: the agent asked to pay
		// and did not succeed, so the honest answer is the bill again, not free content.
		return $this->logged(
			array(
				'action'  => 'pay',
				'header'  => $built['header'],
				'receipt' => '',
				'license' => '',
				'reason'  => 'settlement failed',
			),
			$post,
			$slug
		);
	}

	/**
	 * The built 402 for a resource, cached. Returns null when the resource is free or the
	 * control plane could not be reached.
	 *
	 * @param string $resource Absolute URL.
	 * @param string $slug     Canonical slug.
	 * @param string $kind     read|citation.
	 * @return array|null {header, legs, quote}
	 */
	private function built_402( $resource, $slug, $kind ) {
		$cache_key = 'naulon_402_' . md5( $slug . '|' . $kind );
		$cached    = get_transient( $cache_key );
		if ( is_array( $cached ) ) {
			return isset( $cached['header'] ) ? $cached : null;
		}

		$response = Naulon_Client::instance()->quote( $resource, $slug, $kind, true );

		// 204 = the deliberate don't-gate signal. Cache it too, so a free article does not ask
		// again on every crawl.
		if ( $response['ok'] && 204 === $response['status'] ) {
			set_transient( $cache_key, array( 'free' => true ), self::QUOTE_TTL );
			return null;
		}
		if ( ! $response['ok'] || ! isset( $response['body']['x402']['header'] ) ) {
			// Unreachable, unauthorized, or an unexpected shape. Do NOT cache a failure — the
			// next request should try again — and serve free meanwhile.
			return null;
		}

		$quote = $response['body'];
		$x402  = $quote['x402'];
		unset( $quote['x402'] ); // /verify wants the quote as the gate priced it, nothing added.

		$built = array(
			'header' => (string) $x402['header'],
			'legs'   => isset( $x402['legs'] ) && is_array( $x402['legs'] ) ? $x402['legs'] : array(),
			'quote'  => $quote,
		);

		// Cache ONLY a nonce-free 402.
		//
		// In gateway mode the 402 carries no nonce — the deposit-backed settle is the replay
		// guard — so the same bytes are correct for every caller and a crawler flood costs one
		// call. In mock mode each leg carries its OWN replay nonce, which is consumed on
		// settle: handing a cached nonce to a second agent would make its payment fail against
		// an already-spent nonce. So we look at what we actually received rather than assuming
		// a mode, and skip the cache when a nonce is present.
		if ( ! self::carries_nonce( $built['legs'] ) ) {
			set_transient( $cache_key, $built, self::QUOTE_TTL );
		}
		return $built;
	}

	/**
	 * Does any leg carry a replay nonce?
	 *
	 * @param array $legs Settlement legs from the built 402.
	 * @return bool
	 */
	private static function carries_nonce( array $legs ) {
		foreach ( $legs as $leg ) {
			if ( isset( $leg['requirements']['extra']['nonce'] ) && '' !== $leg['requirements']['extra']['nonce'] ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Send the 402.
	 *
	 * @param array $decision The decision.
	 * @return void
	 */
	private function send_402( array $decision ) {
		$this->no_store();
		status_header( 402 );
		header( self::PAYMENT_REQUIRED_HEADER . ': ' . $decision['header'] );
		header( 'Content-Type: application/json; charset=utf-8' );
		echo wp_json_encode(
			array(
				'error'    => 'payment required',
				'resource' => esc_url_raw( get_permalink() ),
			)
		);
		exit;
	}

	/**
	 * Is this the site talking to itself? A logged-in cookie, a REST nonce, or a same-origin
	 * referer. Getting this wrong 402s the publisher's own editor, so it is checked before
	 * anything else and is deliberately generous.
	 *
	 * @return bool
	 */
	public function is_first_party() {
		if ( is_user_logged_in() ) {
			return true;
		}
		if ( '' !== $this->header( 'X-WP-Nonce' ) ) {
			return true;
		}
		$home = wp_parse_url( home_url(), PHP_URL_HOST );
		foreach ( array( 'Origin', 'Referer' ) as $name ) {
			$value = $this->header( $name );
			if ( '' === $value ) {
				continue;
			}
			$host = wp_parse_url( $value, PHP_URL_HOST );
			if ( is_string( $host ) && is_string( $home ) && strtolower( $host ) === strtolower( $home ) ) {
				return true;
			}
		}
		/**
		 * Filter the first-party verdict — the escape hatch for a headless front end on another
		 * origin, which would otherwise be tolled like any other machine.
		 *
		 * @param bool $first_party Current verdict.
		 */
		return (bool) apply_filters( 'naulon_is_first_party', false );
	}

	/**
	 * The publisher's classification policy. Cached from the control plane where available.
	 *
	 * @return array
	 */
	private function policy() {
		$settings = Naulon_Settings::all();
		return array(
			'seo_allowlist' => isset( $settings['seo_allowlist'] ) && is_array( $settings['seo_allowlist'] ) ? $settings['seo_allowlist'] : array(),
			'charge_list'   => isset( $settings['charge_list'] ) && is_array( $settings['charge_list'] ) ? $settings['charge_list'] : array(),
		);
	}

	/**
	 * The last classification of this host by the control plane, cached. Used only to stand
	 * down on a `conflict`.
	 *
	 * @return string
	 */
	private function cached_enforcement_mode() {
		$cached = get_transient( 'naulon_enforcement_mode' );
		return is_string( $cached ) ? $cached : '';
	}

	/**
	 * A read, or a citation? An agent declares which by header; anything else is a read.
	 *
	 * @return string
	 */
	private function requested_kind() {
		return 'citation' === strtolower( $this->header( 'X-Naulon-Kind' ) ) ? 'citation' : 'read';
	}

	/**
	 * One request header, or ''.
	 *
	 * @param string $name Header name.
	 * @return string
	 */
	private function header( $name ) {
		$key = 'HTTP_' . strtoupper( str_replace( '-', '_', $name ) );
		if ( ! isset( $_SERVER[ $key ] ) ) {
			return '';
		}
		return trim( sanitize_text_field( wp_unslash( $_SERVER[ $key ] ) ) );
	}

	/**
	 * Keep every cache layer off an agent response. A cached 402 served to a human, or cached
	 * paid content served to someone who did not pay, are both worse than no caching at all.
	 *
	 * @return void
	 */
	private function no_store() {
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- a third-party cache constant, recognized by name.
			define( 'DONOTCACHEPAGE', true );
		}
		nocache_headers();
		header( 'Cache-Control: private, no-store' );
	}

	/**
	 * @param string $reason Why this read is free.
	 * @return array
	 */
	private function free( $reason ) {
		return array(
			'action'  => 'free',
			'header'  => '',
			'receipt' => '',
			'license' => '',
			'reason'  => $reason,
		);
	}

	/**
	 * Test seam: forget the memoized decision.
	 *
	 * @return void
	 */
	public function reset() {
		$this->decision = null;
	}
}
