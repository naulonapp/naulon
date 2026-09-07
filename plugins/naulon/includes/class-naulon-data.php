<?php
/**
 * What happens to a publisher's data when this plugin is deleted — and why the answer changed.
 *
 * It used to be: everything goes. `uninstall.php` removed the settings, every author's wallet
 * address, the per-post toll marks, and it DROPPED the earnings table. The reasoning was that a
 * payout address left in a database nobody watches is worse than one deleted, and that argument
 * is not wrong. What it missed is that WordPress runs uninstall **before** it removes the files
 * (`wp-admin/includes/plugin.php`: `uninstall_plugin()` then `$wp_filesystem->delete()`), so
 * "Delete" is one click, has no undo, and its warning is core's generic "files and data".
 *
 * That combination cost a real site: a delete attempted on a plugin whose directory was owned by
 * root — so the file removal failed and the plugin visibly stayed installed — while the data was
 * already gone. Wallets entered by hand, and a record of money, destroyed by an action that
 * appeared not to have happened at all.
 *
 * So the default flipped: **deleting the plugin now keeps your data.** Removal is still offered,
 * but as a deliberate choice made in advance, on a screen that shows exactly what it would
 * destroy. Two things still go unconditionally, because they are our CODE rather than your data:
 * the must-use cache guard (a drop-in left running for a plugin that no longer exists is a bug,
 * not a keepsake) and the heartbeat schedule (an event whose handler has been deleted).
 *
 * The anti-stranding argument is answered rather than ignored: the choice is on the Diagnostics
 * screen with live counts next to it, and there is an export, so "remove it all" is a decision a
 * publisher can make with the numbers in front of them instead of discovering it afterwards.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Data {

	/**
	 * Settings key. Default false — see the class docblock. A publisher who wants the old
	 * behaviour ticks one box; a publisher who mis-clicks Delete loses nothing.
	 */
	const PURGE_SETTING = 'purge_on_uninstall';

	/**
	 * Read the policy out of a settings array.
	 *
	 * Takes the array rather than fetching it, so the decision is a pure function and is tested
	 * as one. The default lives in `Naulon_Settings::all()`; this only refuses to treat a missing
	 * or non-boolean value as consent.
	 *
	 * @param array $settings Settings array.
	 * @return bool
	 */
	public static function should_purge( array $settings ) {
		return isset( $settings[ self::PURGE_SETTING ] ) && true === $settings[ self::PURGE_SETTING ];
	}

	/**
	 * What deleting the plugin would destroy, as counts. Rendered next to the choice so it is made
	 * with the numbers visible — the whole point of moving this decision earlier in time.
	 *
	 * @return array {wallets:int, settlements:int, tolled_posts:int, settled_total:string}
	 */
	public static function inventory() {
		// Both counts go through the core query APIs rather than `$wpdb`: these are core tables,
		// so an abstraction exists, and it carries the object cache and the multisite switching
		// a hand-written COUNT(*) would quietly bypass.
		$wallets = count( self::wallet_users() );

		// Every registered type and status, because the mark is not confined to `post`: this is
		// an inventory of what a purge would destroy, and a number that quietly excluded a custom
		// post type would understate exactly the thing the screen exists to state.
		$tolled_query = new WP_Query(
			array(
				'post_type'              => array_values( get_post_types() ),
				'post_status'            => array_values( get_post_stati() ),
				'meta_key'               => Naulon_Credits::POST_TOLL_META, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key -- see above.
				'fields'                 => 'ids',
				'posts_per_page'         => 1,
				'ignore_sticky_posts'    => true,
				'update_post_meta_cache' => false,
				'update_post_term_cache' => false,
			)
		);
		$tolled = (int) $tolled_query->found_posts;

		return array(
			'wallets'       => $wallets,
			'settlements'   => Naulon_Ledger::settlement_count(),
			'tolled_posts'  => $tolled,
			'settled_total' => Naulon_Ledger::format_usdc( Naulon_Ledger::site_total() ),
		);
	}

	/**
	 * Every user who has a wallet address, ordered by login.
	 *
	 * One definition, used by both the count and the export, so the number a publisher is shown
	 * before a purge and the rows they can export are the same set by construction.
	 *
	 * The emptiness test is done here rather than in the query on purpose: `meta_value => ''`
	 * with `meta_compare => '!='` does NOT mean "not empty" to `WP_Meta_Query` — an empty value
	 * is dropped from the clause, leaving a bare EXISTS, so a user whose wallet was blanked by
	 * something other than this plugin would be counted as having one. (Measured: a seeded empty
	 * row made the count read 3 against the 2 the SQL this replaced returned.) Clearing a wallet
	 * through either of our own screens deletes the row, so this is about rows we did not write.
	 *
	 * @return WP_User[]
	 */
	private static function wallet_users() {
		$users = get_users(
			array(
				'meta_key' => Naulon_Credits::USER_WALLET_META, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key -- an admin screen rendered on demand, not a front-end query.
				'orderby'  => 'login',
				'order'    => 'ASC',
			)
		);

		$with_wallet = array();
		foreach ( $users as $user ) {
			$wallet = get_user_meta( $user->ID, Naulon_Credits::USER_WALLET_META, true );
			if ( is_string( $wallet ) && '' !== $wallet ) {
				$with_wallet[] = $user;
			}
		}
		return $with_wallet;
	}

	/**
	 * Everything a publisher would need to rebuild this by hand, as a plain array.
	 *
	 * Streamed to the browser as a download, never written to disk: a dump sitting under
	 * `wp-content/uploads/` is a list of payout addresses at a guessable URL, which is a worse
	 * outcome than the data loss it protects against.
	 *
	 * @return array
	 */
	public static function export_payload() {
		$rows = array();
		foreach ( self::wallet_users() as $user ) {
			$rows[] = array(
				'user_login' => $user->user_login,
				'user_email' => $user->user_email,
				'wallet'     => (string) get_user_meta( $user->ID, Naulon_Credits::USER_WALLET_META, true ),
			);
		}

		return array(
			'exported_from' => home_url(),
			'exported_at'   => gmdate( 'c' ),
			'plugin_version' => NAULON_VERSION,
			'wallets'       => $rows,
			'earnings'      => Naulon_Ledger::recent( 10000 ),
			'settings'      => self::exportable_settings(),
		);
	}

	/**
	 * Settings worth carrying to a rebuild, minus the secret. The API key is deliberately absent:
	 * an export is a file that travels — through a downloads folder, an email, a support ticket —
	 * and a key that can quote and settle has no business in one. It is re-pasted from the
	 * dashboard, which takes seconds.
	 *
	 * @return array
	 */
	public static function exportable_settings() {
		$s = Naulon_Settings::all();

		$keep = array( 'api_base', 'gate_url', 'challenge_host', 'verified_at', 'enforcement_on', 'seo_allowlist', 'charge_list' );
		$out  = array();
		foreach ( $keep as $key ) {
			if ( isset( $s[ $key ] ) ) {
				$out[ $key ] = $s[ $key ];
			}
		}
		return $out;
	}

	/**
	 * Our code, removed on uninstall no matter what the data policy says. Neither of these is the
	 * publisher's information: one is a file of ours that would keep executing on every request
	 * for a plugin that no longer exists, the other a scheduled event whose handler is gone.
	 *
	 * @return void
	 */
	public static function remove_code_artifacts() {
		$dropin = Naulon_Cache::dropin_path();
		if ( file_exists( $dropin ) ) {
			wp_delete_file_from_directory( $dropin, dirname( $dropin ) );
		}

		Naulon_Cron::instance()->unschedule();

		// Our cached copy of the control plane's licence document. Not the publisher's data —
		// it is regenerated from their settings on demand — and a stale licence outliving the
		// plugin that fetched it would state terms nothing is enforcing.
		delete_option( Naulon_License::OPTION );
		delete_transient( Naulon_License::RETRY_TRANSIENT );
	}

	/**
	 * The destructive path — reached only when the publisher asked for it in advance.
	 *
	 * Kept in one method rather than inline in `uninstall.php` so it can be called by a test.
	 * `UninstallGuardTest` asserts `uninstall.php` performs no deletion of its own, which is what
	 * makes "everything destructive is behind the opt-in" a property of the code rather than a
	 * claim in a comment.
	 *
	 * @return void
	 */
	public static function purge() {
		Naulon_Settings::delete_all();
		Naulon_Roles::remove_capabilities();
		Naulon_Log::clear();
		Naulon_Observer::clear();

		// A record of money. On chain is the copy that lasts, and the export above is the copy a
		// publisher can read — this only goes because they asked for it to.
		Naulon_Ledger::drop();

		delete_metadata( 'user', 0, Naulon_Credits::USER_WALLET_META, '', true );
		delete_post_meta_by_key( Naulon_Credits::POST_TOLL_META );
	}

	/**
	 * The uninstall entry point: code artifacts always, data only on request.
	 *
	 * @return bool Whether the data was purged.
	 */
	public static function uninstall() {
		self::remove_code_artifacts();

		if ( ! self::should_purge( Naulon_Settings::all() ) ) {
			return false;
		}

		self::purge();
		return true;
	}

	/**
	 * The first directory inside the plugin that the web server cannot write to, or '' if it can
	 * write to all of them.
	 *
	 * This is the failure that started all of this, made self-diagnosing. Removing or replacing a
	 * file needs write permission on its **parent directory**, not on the file, so a single
	 * subdirectory owned by another user (root, typically, from an install done over SSH or with
	 * `docker exec` as root) makes WordPress unable to update OR delete the plugin — and core
	 * reports it as "Could not fully remove the plugin", or lists every file as unwritable, with
	 * no hint about ownership. One check turns that into a sentence naming the directory.
	 *
	 * The walk goes through `WP_Filesystem` rather than PHP's own filesystem calls, so the
	 * answer comes from the same abstraction WordPress will itself use when it tries to update
	 * or delete the plugin — which is the failure being diagnosed. A site whose filesystem
	 * method is not `direct` cannot be answered without asking for credentials, and a
	 * diagnostic screen may not prompt: there we return '' and say nothing, because naming a
	 * directory we could not test would be a guess dressed as a finding.
	 *
	 * @return string Absolute path, or '' when every directory is writable — or when the
	 *                filesystem could not be read without credentials.
	 */
	public static function first_unwritable_dir() {
		global $wp_filesystem;

		if ( ! function_exists( 'WP_Filesystem' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		if ( ! WP_Filesystem() || ! is_object( $wp_filesystem ) ) {
			return '';
		}

		$root = untrailingslashit( NAULON_PLUGIN_DIR );
		if ( ! $wp_filesystem->is_writable( $root ) ) {
			return $root;
		}

		foreach ( self::child_dirs( $root ) as $dir ) {
			if ( ! $wp_filesystem->is_writable( $dir ) ) {
				return $dir;
			}
			foreach ( self::child_dirs( $dir ) as $sub ) {
				if ( ! $wp_filesystem->is_writable( $sub ) ) {
					return $sub;
				}
			}
		}

		return '';
	}

	/**
	 * The directories directly inside a path, as absolute paths.
	 *
	 * @param string $path Absolute path to list.
	 * @return string[]
	 */
	private static function child_dirs( $path ) {
		global $wp_filesystem;

		$list = $wp_filesystem->dirlist( $path, false, false );
		if ( ! is_array( $list ) ) {
			return array();
		}

		$dirs = array();
		foreach ( $list as $name => $item ) {
			if ( isset( $item['type'] ) && 'd' === $item['type'] ) {
				$dirs[] = trailingslashit( $path ) . $name;
			}
		}
		return $dirs;
	}
}
