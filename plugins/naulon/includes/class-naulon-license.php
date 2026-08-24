<?php
/**
 * Publishing the site's licence — the terms in a form a crawler reads before it decides.
 *
 * The toll already enforces terms: agents pay, humans and search read free. RSL (Really Simple
 * Licensing) is the standard for STATING them. The control plane generates the document from the
 * site's own price and scope; what it cannot do is serve it, because this site's origin serves
 * every page and the fleet is never in the request path.
 *
 * So all four of RSL's discovery mechanisms are the publisher's here, and three of them are
 * things WordPress can do without anyone being asked:
 *
 *   • the document at `/license.xml` — a rewrite, so it is independent of the theme;
 *   • `License:` in robots.txt — the one surface a crawler may read BEFORE fetching any page;
 *   • `<link rel="license">` in wp_head — for a crawler that parses HTML and nothing else.
 *
 * (The fourth is the HTTP `Link` header, which would cost a filter on every response to say what
 * the head link already says to the same reader.)
 *
 * ## Never advertise a document that is not there
 *
 * The pointers are printed only when a licence has actually been fetched and stored. A robots
 * line pointing at a 404 is worse than silence: it tells a crawler the terms exist and then
 * refuses to show them, which is exactly the shape of a site that is trying to hide something.
 *
 * ## Never fetch on a page render
 *
 * The document is refreshed from the hourly heartbeat and, at most, by a request for
 * `/license.xml` itself. A reader's page view reads one option and prints one line. A failed
 * fetch backs off, and the last good document keeps being served — terms that are a day stale
 * are still true; a gap in them is not.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_License {

	/** The query var the rewrite maps into. */
	const QUERY_VAR = 'naulon_license';

	/** The path RSL's own examples use, and what the document's Link header points at. */
	const PATH = '/license.xml';

	/** The stored document: {xml, fetched_at}. An option, not a transient — this must survive a
	 *  cache flush, because losing it silently retracts the site's published terms. */
	const OPTION = 'naulon_license';

	/** How old a stored document may get before a refresh is attempted. The document itself
	 *  carries `max-age="1"` (one day), so half a day keeps us inside our own promise. */
	const MAX_AGE = 43200; // 12 hours.

	/** Backoff after a failed fetch, so an unreachable control plane costs one call per window
	 *  rather than one per crawler hit. */
	const RETRY_TRANSIENT = 'naulon_license_retry';
	const RETRY_TTL       = 900; // 15 minutes.

	/** @var Naulon_License|null */
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
		// `parse_request` for the same reason as the ownership challenge: WordPress's canonical
		// redirect runs later and 301s a path like this to a trailing-slash variant whenever the
		// permalink structure ends in one. A crawler that does not follow the redirect sees no
		// licence at all.
		add_action( 'parse_request', array( $this, 'maybe_serve' ) );
		add_filter( 'redirect_canonical', array( $this, 'block_canonical_redirect' ), 10, 2 );
		add_filter( 'robots_txt', array( $this, 'add_robots_line' ), 10, 2 );
		add_action( 'wp_head', array( $this, 'print_link_tag' ) );
	}

	/**
	 * The rewrite, at 'top' so it outruns a page rule or an SEO plugin's catch-all.
	 *
	 * @return void
	 */
	public function add_rewrite_rules() {
		add_rewrite_rule( '^license\.xml$', 'index.php?' . self::QUERY_VAR . '=1', 'top' );
	}

	/**
	 * @param string[] $vars Existing query vars.
	 * @return string[]
	 */
	public function add_query_var( $vars ) {
		$vars[] = self::QUERY_VAR;
		return $vars;
	}

	/**
	 * Never canonical-redirect the licence path.
	 *
	 * @param string|false $redirect_url  Where WordPress wants to send this.
	 * @param string       $requested_url What was asked for.
	 * @return string|false
	 */
	public function block_canonical_redirect( $redirect_url, $requested_url ) {
		if ( is_string( $requested_url ) && false !== strpos( $requested_url, self::PATH ) ) {
			return false;
		}
		return $redirect_url;
	}

	/**
	 * Serve the document.
	 *
	 * @param WP $wp The WordPress environment, mid-parse. Query vars are on it directly —
	 *               `get_query_var()` is not populated this early.
	 * @return void
	 */
	public function maybe_serve( $wp = null ) {
		if ( is_object( $wp ) && isset( $wp->query_vars ) && is_array( $wp->query_vars ) ) {
			$asked = isset( $wp->query_vars[ self::QUERY_VAR ] ) ? $wp->query_vars[ self::QUERY_VAR ] : '';
		} else {
			$asked = get_query_var( self::QUERY_VAR );
		}
		if ( '' === $asked || '0' === $asked ) {
			return;
		}

		$xml = $this->document( true );
		if ( '' === $xml ) {
			// No terms to state. 404 rather than an empty `<rsl>`: an empty document is a
			// licensing STATEMENT, and a wrong one is worse than none.
			status_header( 404 );
			nocache_headers();
			exit;
		}

		status_header( 200 );
		header( 'Content-Type: application/rsl+xml; charset=utf-8' );
		// Matches the document's own `max-age="1"` (days), so a crawler caching by HTTP and one
		// honouring the RSL attribute do not end up with different ideas of freshness.
		header( 'Cache-Control: public, max-age=86400' );
		echo $xml; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- XML from the control plane, served verbatim; escaping it would corrupt the document.
		exit;
	}

	/**
	 * `License: https://example.com/license.xml` in robots.txt.
	 *
	 * @param string $output The robots.txt body WordPress built.
	 * @param bool   $public Whether the site is set to be indexed.
	 * @return string
	 */
	public function add_robots_line( $output, $public = true ) {
		if ( '' === $this->document() ) {
			return $output;
		}
		return rtrim( (string) $output, "\n" ) . "\nLicense: " . self::url() . "\n";
	}

	/**
	 * `<link rel="license">` in the document head.
	 *
	 * @return void
	 */
	public function print_link_tag() {
		if ( '' === $this->document() ) {
			return;
		}
		printf(
			'<link rel="license" href="%s" type="application/rsl+xml" />' . "\n",
			esc_url( self::url() )
		);
	}

	/**
	 * Refresh the stored document if it is stale. Called from the hourly heartbeat, where a
	 * fetch costs nobody's page view.
	 *
	 * @return bool True when a fresh document was stored.
	 */
	public function refresh() {
		$stored = $this->stored();
		if ( ! $this->is_stale( $stored ) ) {
			return false;
		}
		return $this->fetch();
	}

	/**
	 * The document to serve or point at.
	 *
	 * @param bool $may_fetch Allow a network call when the store is empty or stale. True only on
	 *                        the licence route itself — never on a page render.
	 * @return string XML, or '' when this site has no licence to publish.
	 */
	public function document( $may_fetch = false ) {
		$stored = $this->stored();
		if ( $may_fetch && $this->is_stale( $stored ) && ! get_transient( self::RETRY_TRANSIENT ) ) {
			if ( $this->fetch() ) {
				$stored = $this->stored();
			}
		}
		return is_string( $stored['xml'] ) ? $stored['xml'] : '';
	}

	/**
	 * The canonical URL of this site's licence — always on the publisher's own domain, which is
	 * the host the document itself names.
	 *
	 * @return string
	 */
	public static function url() {
		return home_url( self::PATH );
	}

	/**
	 * Fetch and store. A failure leaves the previous document in place and starts a backoff:
	 * stale terms are still the publisher's terms, and withdrawing them over a network blip
	 * would be a licensing change nobody asked for.
	 *
	 * @return bool
	 */
	private function fetch() {
		$result = Naulon_Client::instance()->license_xml();
		if ( ! $result['ok'] || '' === $result['xml'] ) {
			set_transient( self::RETRY_TRANSIENT, 1, self::RETRY_TTL );
			return false;
		}
		delete_transient( self::RETRY_TRANSIENT );
		$had_document = ( '' !== $this->stored()['xml'] );
		update_option(
			self::OPTION,
			array(
				'xml'        => $result['xml'],
				'fetched_at' => time(),
			),
			false // not autoloaded: read on the licence route and on wp_head, both of which read it explicitly.
		);
		if ( ! $had_document ) {
			// The rewrite rule is registered on `init`, but WordPress only writes the rule set on
			// a flush — and activation is the only flush this plugin performs. A site that
			// UPGRADED into this version was never re-activated, so `/license.xml` would 404
			// while robots.txt advertised it. Flush once, at the moment there is first something
			// to serve; it costs one option write per site, ever.
			$this->add_rewrite_rules();
			flush_rewrite_rules( false );
		}
		return true;
	}

	/**
	 * @return array {xml:string, fetched_at:int}
	 */
	private function stored() {
		$stored = get_option( self::OPTION, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}
		return array(
			'xml'        => isset( $stored['xml'] ) && is_string( $stored['xml'] ) ? $stored['xml'] : '',
			'fetched_at' => isset( $stored['fetched_at'] ) ? (int) $stored['fetched_at'] : 0,
		);
	}

	/**
	 * @param array $stored The stored document.
	 * @return bool
	 */
	private function is_stale( array $stored ) {
		if ( '' === Naulon_Settings::api_key() ) {
			return false; // nothing to fetch with — not stale, just absent.
		}
		return '' === $stored['xml'] || ( time() - $stored['fetched_at'] ) > self::MAX_AGE;
	}
}
