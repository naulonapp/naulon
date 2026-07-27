<?php
/**
 * Serving the ownership challenge — the half of verification that WordPress makes easy and
 * that is otherwise the wall a non-technical publisher hits.
 *
 * Two methods are served automatically, and both matter for different failure modes:
 *   • well-known — `/.well-known/naulon-challenge/<token>`, a rewrite rule. Independent of the
 *     theme, so a broken or minimal theme cannot break verification.
 *   • meta-tag  — a tag in wp_head. Survives the security plugins and static-404 handlers that
 *     swallow anything under `/.well-known/`, which is a real and common configuration.
 *
 * Serving both means one of them almost always gets through. What the plugin must never do is
 * claim "verification ready" when the checker cannot possibly succeed, so the constraints of
 * the checker are encoded here as first-class facts:
 *
 *   • The check is https-only — a plain-http site cannot pass, and is told so.
 *   • A 3xx is NEVER followed. If example.com redirects to www.example.com, verifying the
 *     redirecting host silently fails; the host that is actually SERVED is the one to verify.
 *   • The response must be the live token, so page caches and optimizers are told to keep off.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Challenge {

	/** The query var the rewrite maps into. */
	const QUERY_VAR = 'naulon_challenge';

	/** The meta tag name — mirrors the Google/Bing site-verification convention. */
	const META_NAME = 'naulon-site-verification';

	/** @var Naulon_Challenge|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Hook registration.
	 *
	 * @return void
	 */
	public function register() {
		add_action( 'init', array( $this, 'add_rewrite_rules' ) );
		add_filter( 'query_vars', array( $this, 'add_query_var' ) );
		add_action( 'template_redirect', array( $this, 'maybe_serve' ) );
		add_action( 'wp_head', array( $this, 'print_meta_tag' ) );
	}

	/**
	 * The rewrite. Registered at 'top' so it outruns page rules and any catch-all a theme or
	 * SEO plugin installed.
	 *
	 * @return void
	 */
	public function add_rewrite_rules() {
		add_rewrite_rule(
			'^\.well-known/naulon-challenge/([^/]+)/?$',
			'index.php?' . self::QUERY_VAR . '=$matches[1]',
			'top'
		);
	}

	/**
	 * Register the query var so WP keeps it through the parse.
	 *
	 * @param string[] $vars Existing vars.
	 * @return string[]
	 */
	public function add_query_var( $vars ) {
		$vars[] = self::QUERY_VAR;
		return $vars;
	}

	/**
	 * Serve the token when the requested one matches what we were issued.
	 *
	 * A MISMATCHED token 404s rather than echoing back whatever was asked for. Echoing would
	 * turn this route into a reflector that proves ownership of any token an attacker chose —
	 * i.e. it would let someone else's tenant verify our host.
	 *
	 * @return void
	 */
	public function maybe_serve() {
		$requested = get_query_var( self::QUERY_VAR );
		if ( ! is_string( $requested ) || '' === $requested ) {
			return;
		}

		$settings = Naulon_Settings::all();
		$token    = is_string( $settings['challenge_token'] ) ? $settings['challenge_token'] : '';

		if ( '' === $token || ! hash_equals( $token, $requested ) ) {
			status_header( 404 );
			nocache_headers();
			exit;
		}

		// Keep every cache layer off this response: the checker must see the live token, and a
		// cached stale token outlives a rotation and fails verification mysteriously.
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true );
		}
		nocache_headers();
		status_header( 200 );
		header( 'Content-Type: text/plain; charset=utf-8' );
		header( 'X-Robots-Tag: noindex' );
		echo esc_html( $token );
		exit;
	}

	/**
	 * The meta tag half. Printed only while a challenge is open — there is no reason to carry
	 * a verification tag on every page forever once ownership is stamped, and leaving it there
	 * just advertises the token.
	 *
	 * @return void
	 */
	public function print_meta_tag() {
		$settings = Naulon_Settings::all();
		$token    = is_string( $settings['challenge_token'] ) ? $settings['challenge_token'] : '';
		if ( '' === $token || Naulon_Settings::is_verified() ) {
			return;
		}
		printf(
			'<meta name="%1$s" content="%2$s" />' . "\n",
			esc_attr( self::META_NAME ),
			esc_attr( $token )
		);
	}

	/**
	 * The absolute URL the control plane will fetch for the well-known method.
	 *
	 * @param string $token The challenge token.
	 * @return string
	 */
	public static function challenge_url( $token ) {
		return home_url( '/.well-known/naulon-challenge/' . rawurlencode( $token ) );
	}
}
