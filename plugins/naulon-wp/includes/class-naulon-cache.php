<?php
/**
 * Page caches — detection, the must-use drop-in, and the only test that actually proves anything.
 *
 * A page cache serves HTML before PHP runs. That makes it the single most dangerous thing on a
 * tolled WordPress site, and the dangerous part is that it fails SILENTLY: nothing looks broken,
 * the site is fast, agents read for free forever, and the publisher's earnings are simply lower
 * than they should be with no error anywhere to explain why.
 *
 * So this class does three things, in increasing order of how much they are worth:
 *
 * 1. **Detect** which cache layers are present. Cheap, and useful for telling a publisher what
 *    they are dealing with — but it is inference, not evidence.
 * 2. **Install the drop-in** that stops agent responses being cached in the first place. Real,
 *    and it closes the "cached 402 shown to a human" hole completely.
 * 3. **Probe the live site** — ask this site for one of its own tolled articles while presenting
 *    a crawler's user agent, and look at what comes back. A 402 means the toll survived every
 *    layer between here and the answer. A 200 means it did not, and the response headers say
 *    which layer answered. This is the only one of the three that is evidence, and it is the one
 *    the Diagnostics screen leads with.
 *
 * The honest limit, stated in the admin UI as well as here: WordPress loads `advanced-cache.php`
 * before mu-plugins, so a cache HIT is answered before any of our code exists. The drop-in stops
 * agent responses from being stored; only the cache layer's own user-agent exclusion can stop a
 * stored page from being served to an agent. The probe is how a publisher finds out which
 * situation they are actually in, rather than being told a comforting story.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Cache {

	/** Must match the constant in mu/naulon-cache-guard.php. */
	const DROPIN_VERSION = 1;

	const DROPIN_FILENAME = 'naulon-cache-guard.php';

	/** A well-known crawler UA for the probe — on the built-in charge list, so a correctly
	 *  enforcing site answers 402. */
	const PROBE_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';

	/**
	 * Where the drop-in belongs.
	 *
	 * @return string
	 */
	public static function dropin_path() {
		$dir = defined( 'WPMU_PLUGIN_DIR' ) ? WPMU_PLUGIN_DIR : WP_CONTENT_DIR . '/mu-plugins';
		/**
		 * Filter where the guard is written. Exists for the test suite and for the rare install
		 * with an unusual layout — not as an invitation to scatter it.
		 *
		 * @param string $path Absolute path to the drop-in.
		 */
		return apply_filters( 'naulon_dropin_path', trailingslashit( $dir ) . self::DROPIN_FILENAME );
	}

	/**
	 * The shipped template the installed copy is written from.
	 *
	 * @return string
	 */
	public static function template_path() {
		return NAULON_PLUGIN_DIR . 'mu/' . self::DROPIN_FILENAME;
	}

	/**
	 * Installed, and is it our current version?
	 *
	 * @return array {installed:bool, current:bool, version:int, path:string}
	 */
	public static function dropin_state() {
		$path  = self::dropin_path();
		$state = array(
			'installed' => false,
			'current'   => false,
			'version'   => 0,
			'path'      => $path,
		);
		if ( ! file_exists( $path ) ) {
			return $state;
		}
		$state['installed'] = true;

		$contents = file_get_contents( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions -- reading a local file we wrote; WP_Filesystem is for writes.
		if ( is_string( $contents ) && preg_match( "/NAULON_CACHE_GUARD_VERSION',\s*(\d+)/", $contents, $m ) ) {
			$state['version'] = (int) $m[1];
			$state['current'] = self::DROPIN_VERSION === $state['version'];
		}
		return $state;
	}

	/**
	 * Write the drop-in, baking in the path to the classifier so there is only ever one
	 * user-agent list on this site.
	 *
	 * @return array {ok:bool, message:string}
	 */
	public static function install_dropin() {
		$template = self::template_path();
		if ( ! is_readable( $template ) ) {
			return array(
				'ok'      => false,
				'message' => __( 'The drop-in template is missing from the plugin directory.', 'naulon' ),
			);
		}

		$contents = file_get_contents( $template ); // phpcs:ignore WordPress.WP.AlternativeFunctions -- reading our own shipped template.
		if ( ! is_string( $contents ) || '' === $contents ) {
			return array(
				'ok'      => false,
				'message' => __( 'The drop-in template could not be read.', 'naulon' ),
			);
		}

		$contents = str_replace(
			'{{AGENT_CLASS_PATH}}',
			NAULON_PLUGIN_DIR . 'includes/class-naulon-agent.php',
			$contents
		);

		$dir = dirname( self::dropin_path() );
		if ( ! file_exists( $dir ) && ! wp_mkdir_p( $dir ) ) {
			return array(
				'ok'      => false,
				/* translators: %s: directory path. */
				'message' => sprintf( __( 'Could not create %s. Create it yourself, or install the file by hand — the contents are shown below.', 'naulon' ), $dir ),
			);
		}

		$written = self::write_file( self::dropin_path(), $contents );
		if ( ! $written ) {
			return array(
				'ok'      => false,
				/* translators: %s: file path. */
				'message' => sprintf( __( 'Could not write %s. The web server does not have permission — install the file by hand instead.', 'naulon' ), self::dropin_path() ),
			);
		}

		return array(
			'ok'      => true,
			'message' => __( 'Cache guard installed. Agent responses are no longer cacheable.', 'naulon' ),
		);
	}

	/**
	 * Remove the drop-in.
	 *
	 * @return array {ok:bool, message:string}
	 */
	public static function remove_dropin() {
		$path = self::dropin_path();
		if ( ! file_exists( $path ) ) {
			return array(
				'ok'      => true,
				'message' => __( 'The cache guard was not installed.', 'naulon' ),
			);
		}
		$removed = wp_delete_file_from_directory( $path, dirname( $path ) );
		return array(
			'ok'      => (bool) $removed,
			'message' => $removed
				? __( 'Cache guard removed.', 'naulon' )
				: __( 'Could not remove the cache guard. Delete the file by hand.', 'naulon' ),
		);
	}

	/**
	 * Write a file through WP_Filesystem when it is available without prompting for credentials,
	 * and fall back to a direct write. A must-use plugin is infrastructure: asking a publisher
	 * for FTP credentials to install a 3 KB guard would mean most of them never install it.
	 *
	 * @param string $path     Destination.
	 * @param string $contents File contents.
	 * @return bool
	 */
	private static function write_file( $path, $contents ) {
		global $wp_filesystem;

		if ( ! function_exists( 'WP_Filesystem' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		if ( WP_Filesystem() && $wp_filesystem instanceof WP_Filesystem_Base ) {
			return (bool) $wp_filesystem->put_contents( $path, $contents, FS_CHMOD_FILE );
		}
		return false !== file_put_contents( $path, $contents ); // phpcs:ignore WordPress.WP.AlternativeFunctions -- WP_Filesystem unavailable; the alternative is not installing the guard at all.
	}

	/**
	 * Which caching layers can be seen from inside PHP.
	 *
	 * Detection is by the constant, function or class each product defines — not by looking for
	 * plugin directories, which are renameable.
	 *
	 * @return array[] Each {id, name, note, controllable}.
	 */
	public static function layers() {
		$found = array();

		if ( defined( 'WP_CACHE' ) && WP_CACHE && file_exists( WP_CONTENT_DIR . '/advanced-cache.php' ) ) {
			$found[] = array(
				'id'           => 'advanced-cache',
				'name'         => __( 'A full-page cache drop-in (advanced-cache.php)', 'naulon' ),
				'note'         => __( 'This runs before every plugin, including this one. It decides whether to answer from the cache before any naulon code exists.', 'naulon' ),
				'controllable' => false,
			);
		}
		if ( defined( 'WPCACHEHOME' ) || function_exists( 'wp_cache_is_enabled' ) ) {
			$found[] = array(
				'id'           => 'wp-super-cache',
				'name'         => 'WP Super Cache',
				'note'         => __( 'Add the crawler user agents to Settings → WP Super Cache → Advanced → Rejected User Agents.', 'naulon' ),
				'controllable' => true,
			);
		}
		if ( defined( 'W3TC' ) || class_exists( 'W3TC\\Root_Loader' ) ) {
			$found[] = array(
				'id'           => 'w3-total-cache',
				'name'         => 'W3 Total Cache',
				'note'         => __( 'Add the crawler user agents to Performance → Page Cache → Advanced → Rejected user agents.', 'naulon' ),
				'controllable' => true,
			);
		}
		if ( defined( 'LSCWP_V' ) ) {
			$found[] = array(
				'id'           => 'litespeed',
				'name'         => 'LiteSpeed Cache',
				'note'         => __( 'Add the crawler user agents to LiteSpeed Cache → Cache → Excludes → Do Not Cache User Agents.', 'naulon' ),
				'controllable' => true,
			);
		}
		if ( defined( 'WP_ROCKET_VERSION' ) ) {
			$found[] = array(
				'id'           => 'wp-rocket',
				'name'         => 'WP Rocket',
				'note'         => __( 'Add the crawler user agents to Advanced Rules → Never Cache User Agent(s).', 'naulon' ),
				'controllable' => true,
			);
		}
		if ( class_exists( 'WpFastestCache' ) ) {
			$found[] = array(
				'id'           => 'wp-fastest-cache',
				'name'         => 'WP Fastest Cache',
				'note'         => __( 'Exclude the crawler user agents under WP Fastest Cache → Exclude → User Agent.', 'naulon' ),
				'controllable' => true,
			);
		}
		if ( file_exists( WP_CONTENT_DIR . '/object-cache.php' ) ) {
			$found[] = array(
				'id'           => 'object-cache',
				'name'         => __( 'A persistent object cache', 'naulon' ),
				'note'         => __( 'Harmless for the toll on its own — it caches queries, not whole responses.', 'naulon' ),
				'controllable' => true,
			);
		}

		return $found;
	}

	/**
	 * The user agents a publisher should paste into whichever exclusion list their cache offers.
	 *
	 * Taken from the classifier, so this list cannot drift from the one that actually decides who
	 * gets charged.
	 *
	 * @return string[]
	 */
	public static function exclusion_fragments() {
		return Naulon_Agent::KNOWN_AGENT_UA;
	}

	/**
	 * Ask this site for one of its own tolled articles, as a crawler, and report exactly what
	 * came back.
	 *
	 * No cache-busting query string, deliberately: adding one is how you get a green result on a
	 * site that is in fact serving cached pages to every real crawler.
	 *
	 * @param WP_Post|null $post Post to test with; the newest tollable one when null.
	 * @return array {ok:bool, tested:bool, status:int, verdict:string, message:string, headers:array, url:string}
	 */
	public static function probe( $post = null ) {
		if ( ! $post instanceof WP_Post ) {
			$post = self::probe_post();
		}
		if ( ! $post instanceof WP_Post ) {
			return array(
				'ok'      => false,
				'tested'  => false,
				'status'  => 0,
				'verdict' => 'no_post',
				'message' => __( 'No article on this site is currently tollable, so there is nothing to test with. Give an author a wallet and publish a post.', 'naulon' ),
				'headers' => array(),
				'url'     => '',
			);
		}

		$url      = get_permalink( $post );
		$response = wp_remote_get(
			$url,
			array(
				'timeout'     => Naulon_Client::TIMEOUT_ADMIN,
				'redirection' => 0,
				'headers'     => array(
					'User-Agent' => self::PROBE_UA,
					'Accept'     => 'text/html',
				),
				'cookies'     => array(),
			)
		);

		if ( is_wp_error( $response ) ) {
			return array(
				'ok'      => false,
				'tested'  => false,
				'status'  => 0,
				'verdict' => 'unreachable',
				/* translators: %s: transport error. */
				'message' => sprintf( __( 'This site could not fetch its own article (%s). That is usually a loopback restriction on the host rather than a caching problem.', 'naulon' ), $response->get_error_message() ),
				'headers' => array(),
				'url'     => $url,
			);
		}

		$status  = (int) wp_remote_retrieve_response_code( $response );
		$headers = self::interesting_headers( $response );

		if ( 402 === $status ) {
			return array(
				'ok'      => true,
				'tested'  => true,
				'status'  => $status,
				'verdict' => 'enforcing',
				'message' => __( 'A crawler asking for this article was charged. Nothing between here and the answer is serving it a cached copy.', 'naulon' ),
				'headers' => $headers,
				// The raw challenge, so the Test toll screen can decode and display the real
				// price, chain and payee instead of asserting that the toll works.
				'challenge' => (string) wp_remote_retrieve_header( $response, 'payment-required' ),
				'url'     => $url,
			);
		}

		if ( 200 === $status ) {
			return array(
				'ok'      => false,
				'tested'  => true,
				'status'  => $status,
				'verdict' => 'under_tolling',
				'message' => __( 'A crawler asking for this article was served the article, free. Either enforcement is off, or something is answering before WordPress runs — the response headers below name the layer.', 'naulon' ),
				'headers' => $headers,
				'url'     => $url,
			);
		}

		return array(
			'ok'      => false,
			'tested'  => true,
			'status'  => $status,
			'verdict' => 'unexpected',
			/* translators: %d: HTTP status code. */
			'message' => sprintf( __( 'A crawler asking for this article got %d, which is neither a toll nor the article.', 'naulon' ), $status ),
			'headers' => $headers,
			'url'     => $url,
		);
	}

	/**
	 * The response headers worth showing — the ones that name a cache layer.
	 *
	 * @param array|WP_Error $response Response from wp_remote_get.
	 * @return array<string, string>
	 */
	private static function interesting_headers( $response ) {
		$names = array(
			'cf-cache-status',
			'x-cache',
			'x-cache-status',
			'x-litespeed-cache',
			'x-wp-super-cache',
			'x-cached-by',
			'age',
			'cache-control',
			'payment-required',
		);
		$out = array();
		foreach ( $names as $name ) {
			$value = wp_remote_retrieve_header( $response, $name );
			if ( is_string( $value ) && '' !== $value ) {
				// The 402's own header is long and is proof rather than diagnosis — show only
				// that it was present.
				$out[ $name ] = 'payment-required' === $name ? __( '(present)', 'naulon' ) : $value;
			}
		}
		return $out;
	}

	/**
	 * The newest post that would actually be tolled — testing with anything else proves nothing.
	 *
	 * @return WP_Post|null
	 */
	public static function probe_post() {
		$credits = Naulon_Credits::instance();
		$posts   = get_posts(
			array(
				'post_type'        => $credits->tollable_post_types(),
				'post_status'      => 'publish',
				'numberposts'      => 10,
				'suppress_filters' => false,
			)
		);
		foreach ( $posts as $post ) {
			if ( $credits->is_tollable( $post ) && ! empty( $credits->contributors_for( $post ) ) ) {
				return $post;
			}
		}
		return null;
	}
}
