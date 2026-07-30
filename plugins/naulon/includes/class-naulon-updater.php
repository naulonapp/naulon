<?php
/**
 * Self-hosted updates, so a publisher never downloads a zip again.
 *
 * This plugin is not on wordpress.org, so the wordpress.org update API knows nothing about it.
 * Until this class existed the consequence was total: WordPress had no source to ask, so no
 * update notice ever appeared, no one-click update was possible, and the auto-update toggle read
 * "Auto-updates are not available for this plugin". Every publisher had to notice a release by
 * hand, download `naulon.zip`, and upload it over the top — which also fails outright on any
 * install whose plugin directory is a bind mount or is owned by another user.
 *
 * The mechanism is core's own, not a bolt-on: `Update URI` (WP 5.8+) makes core route this
 * plugin's update check to the `update_plugins_{hostname}` filter instead of to wordpress.org.
 * See `wp-includes/update.php` — core requires only a `version` in what the filter returns, and
 * stamps `id`/`plugin` itself.
 *
 * Four decisions worth knowing, because each one is a bug in most self-hosted updaters:
 *
 * 1. **The filter returns the payload even when the versions match.** Core files an equal
 *    version under `no_update`, and `WP_Plugins_List_Table` reads exactly that to decide
 *    `update-supported` — which is what renders the auto-update toggle at all. Returning `false`
 *    when up to date is the reason so many self-hosted plugins can be updated by hand but never
 *    automatically.
 * 2. **The download host is pinned, not read from the manifest — and re-checked on every read.**
 *    The `package` URL is code this site will unpack and execute. Validating before caching is not
 *    enough: the cache is a database row, so an unrelated SQL injection or a restored backup would
 *    otherwise be remote code execution. See `manifest()`.
 * 3. **`tested` is normalised to the running patch version.** A readme claims a WordPress branch;
 *    core compares against the full version. Unhandled, that warns "not tested with your current
 *    version" on every WordPress patch release. See `tested_for()`.
 * 4. **Every failure is silence.** No manifest, a malformed one, an unreachable host: the filter
 *    returns what it was given and WordPress behaves exactly as it did before. An updater that
 *    white-screens the plugins page, or nags about a check it could not complete, costs more than
 *    the manual download it replaced.
 *
 * The manifest itself is generated in CI from this plugin's own headers and readme
 * (`scripts/wp-update-manifest.mjs`) and attached to the GitHub release beside the zip, so the
 * version a site is offered cannot drift from the version in the zip it downloads. Nothing is
 * hand-published per release.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Updater {

	/**
	 * The manifest, at the same version-free redirector the zip uses. `releases/latest` always
	 * resolves to the newest published (non-prerelease) release, so no URL anywhere needs
	 * bumping when a version ships.
	 */
	const MANIFEST_URL = 'https://github.com/naulonapp/naulon/releases/latest/download/naulon-update.json';

	/**
	 * The only host a package may be downloaded from. See decision 2 above: this is the trust
	 * boundary of the whole feature, and it is a constant here rather than a manifest field
	 * precisely so a manifest cannot move it.
	 */
	const PACKAGE_PREFIX = 'https://github.com/naulonapp/naulon/releases/';

	/** Where the plugin's own slug lives — the update transient, `plugins_api`, and the modal. */
	const SLUG = 'naulon';

	const TRANSIENT = 'naulon_update_manifest';

	/**
	 * Six hours. Core already throttles its own update checks (twice daily, more often in the
	 * admin), so this only stops repeated admin page loads inside one check window from each
	 * making a request.
	 */
	const TTL = 6 * HOUR_IN_SECONDS;

	/**
	 * A failed fetch is cached too, as the string below. Without a negative cache, a release
	 * host that is down or a site with no outbound network makes a doomed HTTP request on every
	 * single update check — the admin pays the timeout, repeatedly, for nothing.
	 */
	const FAILURE = 'unavailable';
	const FAILURE_TTL = 30 * MINUTE_IN_SECONDS;

	/**
	 * Update checks can run inside an admin page load, so the budget is tighter than
	 * `Naulon_Client::TIMEOUT_ADMIN` (an administrator who clicked a button is waiting on
	 * purpose; one who opened the plugins list is not). Five seconds is enough for a CDN
	 * redirect plus a small JSON body.
	 */
	const TIMEOUT = 5;

	/** @var Naulon_Updater|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * The filter name carries the host from the `Update URI` header, because that is how core
	 * routes the check. `NAULON_UPDATE_URI` is the same string as the header — UpdaterTest
	 * asserts they cannot drift, the same discipline VersionTest applies to the version.
	 */
	public function register() {
		$host = wp_parse_url( NAULON_UPDATE_URI, PHP_URL_HOST );
		if ( ! $host ) {
			return;
		}

		add_filter( 'update_plugins_' . $host, array( $this, 'offer' ), 10, 3 );
		add_filter( 'plugins_api', array( $this, 'details' ), 10, 3 );

		// After an update installs, the cached manifest describes the version just replaced.
		// Dropping it means the plugins screen reflects reality on the very next load.
		add_action( 'upgrader_process_complete', array( $this, 'flush' ), 10, 0 );
	}

	/**
	 * Answer core's update check for this plugin.
	 *
	 * @param array|false $update      What a previous filter decided. Returned untouched on any
	 *                                 path this class declines to answer.
	 * @param array       $plugin_data The plugin headers core read from disk.
	 * @param string      $plugin_file Plugin file, relative to the plugins directory.
	 * @return array|false
	 */
	public function offer( $update, $plugin_data, $plugin_file ) {
		// Another plugin could legitimately carry an `Update URI` on this host one day. Answering
		// for a file that is not ours would offer it OUR zip — so decline rather than assume.
		if ( plugin_basename( NAULON_PLUGIN_FILE ) !== $plugin_file ) {
			return $update;
		}

		$manifest = $this->manifest();
		if ( null === $manifest ) {
			return $update;
		}

		return self::payload( $manifest, $plugin_file, get_bloginfo( 'version' ) );
	}

	/**
	 * Serve the "View details" modal. Once the payload carries a `slug`, core links the row to
	 * `plugin-install.php?tab=plugin-information` (see `wp_plugin_update_row`) instead of to an
	 * external URL — so without this filter the notice would link to a modal that renders
	 * "plugin not found". The two belong together.
	 *
	 * @param false|object|array $result The response, or false to let wordpress.org answer.
	 * @param string             $action The API action being requested.
	 * @param object             $args   Request arguments.
	 * @return false|object|array
	 */
	public function details( $result, $action, $args ) {
		if ( 'plugin_information' !== $action ) {
			return $result;
		}
		if ( ! isset( $args->slug ) || self::SLUG !== $args->slug ) {
			return $result;
		}

		$manifest = $this->manifest();
		if ( null === $manifest ) {
			return $result;
		}

		return (object) self::information( $manifest, get_bloginfo( 'version' ) );
	}

	public function flush() {
		delete_site_transient( self::TRANSIENT );
	}

	/**
	 * The validated manifest, or null. Cached in a SITE transient, not a blog one: the update
	 * transient core writes is site-wide, and on multisite a per-blog cache would have every
	 * site in the network fetch the same document.
	 *
	 * @return array|null
	 */
	private function manifest() {
		if ( $this->forced_check() ) {
			delete_site_transient( self::TRANSIENT );
		}

		$cached = get_site_transient( self::TRANSIENT );
		if ( self::FAILURE === $cached ) {
			return null;
		}
		if ( is_array( $cached ) ) {
			// Re-validated on the way OUT of the cache, not just on the way in. A transient lives
			// in the database, so "we validated it before storing it" only holds while nothing
			// else can write there — and SQL injection in an unrelated plugin, or a restored
			// backup, breaks that assumption. Since what this document names is a zip WordPress
			// will unpack and execute, the check belongs on every read: the cost is a regex and a
			// string compare, and the alternative is that one writable row is remote code
			// execution. A poisoned entry is dropped rather than returned, so the next check
			// fetches a real one instead of being stuck behind it.
			$valid = self::validate( $cached );
			if ( null === $valid ) {
				delete_site_transient( self::TRANSIENT );
			}
			return $valid;
		}

		$response = wp_remote_get(
			self::MANIFEST_URL,
			array(
				'timeout' => self::TIMEOUT,
				'headers' => array( 'Accept' => 'application/json' ),
			)
		);

		$manifest = null;
		if ( ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response ) ) {
			$decoded = json_decode( wp_remote_retrieve_body( $response ), true );
			if ( is_array( $decoded ) ) {
				$manifest = self::validate( $decoded );
			}
		}

		if ( null === $manifest ) {
			set_site_transient( self::TRANSIENT, self::FAILURE, self::FAILURE_TTL );
			return null;
		}

		set_site_transient( self::TRANSIENT, $manifest, self::TTL );
		return $manifest;
	}

	/**
	 * Core appends `force-check=1` when an administrator clicks "Check again" on the updates
	 * screen. Honouring it is what makes that button mean something for this plugin; ignoring it
	 * would leave a publisher clicking a button that cannot change the answer for six hours.
	 *
	 * Read-only and admin-only — nothing is written or acted on, so this reads the flag without a
	 * nonce, exactly as core's own update screens do.
	 */
	private function forced_check() {
		return is_admin() && isset( $_GET['force-check'] ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
	}

	/**
	 * Accept a manifest or reject it whole. There is no repair path on purpose: a manifest we
	 * had to correct is a manifest we do not understand, and the thing it describes is code
	 * about to be executed on a publisher's server.
	 *
	 * @param array $m Decoded manifest.
	 * @return array|null The manifest, or null if it cannot be trusted.
	 */
	public static function validate( array $m ) {
		$version = isset( $m['version'] ) ? (string) $m['version'] : '';
		$package = isset( $m['package'] ) ? (string) $m['package'] : '';

		// A version core cannot compare is worse than no answer: `version_compare` on garbage
		// silently decides something. Digits and dots, with an optional prerelease suffix.
		if ( 1 !== preg_match( '/^\d+(\.\d+){0,3}(-[A-Za-z0-9.]+)?$/', $version ) ) {
			return null;
		}

		// The pinned host, checked as a prefix on the literal string. Not `wp_parse_url` on the
		// host alone: `https://github.com.evil.example/` parses to a different host but would
		// pass a naive substring test, and the path is what actually pins the repository.
		if ( 0 !== strpos( $package, self::PACKAGE_PREFIX ) ) {
			return null;
		}

		if ( isset( $m['slug'] ) && self::SLUG !== $m['slug'] ) {
			return null;
		}

		return $m;
	}

	/**
	 * `Tested up to` as core wants to read it, which is not what a readme means by it.
	 *
	 * A readme says `Tested up to: 7.0` — a WordPress BRANCH. Core compares that against the full
	 * running version: `version_compare( '7.0.2', '7.0', '<=' )` is false, so the details modal
	 * warns "this plugin has not been tested with your current version of WordPress" on every
	 * patch release. On wordpress.org that never happens, because their API normalises the branch
	 * to its newest patch before handing it over — asked directly from a test install, wp.org
	 * reports `tested=7.0.2` for plugins whose readmes say 7.0, while a plugin genuinely left on
	 * an older branch (Hello Dolly, 6.9.5) does warn. Nothing performs that normalisation for a
	 * self-hosted plugin, so this does, in the one place that knows the running version.
	 *
	 * A branch is widened only to a patch OF THAT BRANCH. A real gap — 7.0 tested against WP 7.1 —
	 * still warns, which is the entire point of the field.
	 *
	 * @param string $tested     What the readme claims.
	 * @param string $wp_version The running WordPress version.
	 * @return string
	 */
	public static function tested_for( $tested, $wp_version ) {
		$tested = (string) $tested;

		// Only a bare `x.y` is a branch. An `x.y.z` claim is already specific — respect it.
		if ( 1 !== preg_match( '/^\d+\.\d+$/', $tested ) ) {
			return $tested;
		}

		return 0 === strpos( (string) $wp_version, $tested . '.' ) ? (string) $wp_version : $tested;
	}

	/**
	 * Manifest → what core's update transient wants.
	 *
	 * `version` is the only field core requires; everything else here earns its place by
	 * changing what a publisher sees. `tested`/`requires`/`requires_php` drive core's own
	 * compatibility warnings, and the icon is why the update row looks like a real plugin rather
	 * than an anonymous entry.
	 *
	 * Returned whether or not the version is newer — see decision 1 in the class docblock.
	 * Everything reads from the arguments alone: no constant, no option, no global, which is what
	 * lets the whole mapping be tested without a WordPress install.
	 *
	 * @param array  $m           Validated manifest.
	 * @param string $plugin_file Plugin file, relative to the plugins directory.
	 * @param string $wp_version  The running WordPress version.
	 * @return array
	 */
	public static function payload( array $m, $plugin_file, $wp_version = '' ) {
		$payload = array(
			'slug'    => self::SLUG,
			'plugin'  => $plugin_file,
			'version' => (string) $m['version'],
			'package' => (string) $m['package'],
			'url'     => isset( $m['url'] ) ? (string) $m['url'] : ( isset( $m['homepage'] ) ? (string) $m['homepage'] : '' ),
		);

		if ( ! empty( $m['tested'] ) ) {
			$payload['tested'] = self::tested_for( $m['tested'], $wp_version );
		}

		foreach ( array( 'requires', 'requires_php', 'upgrade_notice' ) as $key ) {
			if ( ! empty( $m[ $key ] ) ) {
				$payload[ $key ] = (string) $m[ $key ];
			}
		}

		// Icons only, deliberately — no banners. Core prints the plugin's NAME over the banner in
		// the details modal (`install_plugin_information()`), and our banner art already carries the
		// wordmark on the left, so sending one renders the name twice, overlapping. The icon has no
		// such overlay and is what the plugins list and search cards actually use. Restore banners
		// here once the art leaves clear space at the bottom-left for a title.
		if ( ! empty( $m['icons'] ) && is_array( $m['icons'] ) ) {
			$payload['icons'] = array_map( 'strval', $m['icons'] );
		}

		return $payload;
	}

	/**
	 * Manifest → what the `plugin_information` modal wants. The shape is wordpress.org's, so the
	 * modal renders with core's own markup and needs nothing of ours.
	 *
	 * @param array  $m          Validated manifest.
	 * @param string $wp_version The running WordPress version.
	 * @return array
	 */
	public static function information( array $m, $wp_version = '' ) {
		$info = array(
			'name'          => isset( $m['name'] ) ? (string) $m['name'] : 'naulon',
			'slug'          => self::SLUG,
			'version'       => (string) $m['version'],
			'download_link' => (string) $m['package'],
			'sections'      => array(),
		);

		if ( ! empty( $m['tested'] ) ) {
			$info['tested'] = self::tested_for( $m['tested'], $wp_version );
		}

		foreach ( array( 'author', 'homepage', 'requires', 'requires_php', 'last_updated' ) as $key ) {
			if ( ! empty( $m[ $key ] ) ) {
				$info[ $key ] = (string) $m[ $key ];
			}
		}

		// See `payload()`: no banners while the art duplicates the title core overlays on it.
		if ( ! empty( $m['icons'] ) && is_array( $m['icons'] ) ) {
			$info['icons'] = array_map( 'strval', $m['icons'] );
		}

		if ( ! empty( $m['sections'] ) && is_array( $m['sections'] ) ) {
			foreach ( $m['sections'] as $name => $body ) {
				$info['sections'][ (string) $name ] = (string) $body;
			}
		}

		return $info;
	}
}
