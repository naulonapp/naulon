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
		global $wpdb;

		$wallets = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->usermeta} WHERE meta_key = %s AND meta_value <> ''",
				Naulon_Credits::USER_WALLET_META
			)
		);

		$tolled = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = %s",
				Naulon_Credits::POST_TOLL_META
			)
		);

		return array(
			'wallets'       => $wallets,
			'settlements'   => Naulon_Ledger::settlement_count(),
			'tolled_posts'  => $tolled,
			'settled_total' => Naulon_Ledger::format_usdc( Naulon_Ledger::site_total() ),
		);
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
		global $wpdb;

		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT u.user_login, u.user_email, m.meta_value AS wallet
				 FROM {$wpdb->usermeta} m
				 INNER JOIN {$wpdb->users} u ON u.ID = m.user_id
				 WHERE m.meta_key = %s AND m.meta_value <> ''
				 ORDER BY u.user_login ASC",
				Naulon_Credits::USER_WALLET_META
			),
			ARRAY_A
		);

		return array(
			'exported_from' => home_url(),
			'exported_at'   => gmdate( 'c' ),
			'plugin_version' => NAULON_VERSION,
			'wallets'       => is_array( $rows ) ? $rows : array(),
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
	 * @return string Absolute path, or ''.
	 */
	public static function first_unwritable_dir() {
		$root = untrailingslashit( NAULON_PLUGIN_DIR );
		if ( ! is_writable( $root ) ) {
			return $root;
		}

		$dirs = glob( $root . '/*', GLOB_ONLYDIR );
		if ( ! is_array( $dirs ) ) {
			return '';
		}

		foreach ( $dirs as $dir ) {
			if ( ! is_writable( $dir ) ) {
				return $dir;
			}
			$nested = glob( $dir . '/*', GLOB_ONLYDIR );
			if ( is_array( $nested ) ) {
				foreach ( $nested as $sub ) {
					if ( ! is_writable( $sub ) ) {
						return $sub;
					}
				}
			}
		}

		return '';
	}
}
