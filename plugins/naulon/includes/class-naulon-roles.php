<?php
/**
 * Capabilities, mapped onto the native roles a WordPress site already has.
 *
 * The split that matters: every author can edit THEIR OWN wallet and see THEIR OWN earnings,
 * and nobody below editor can see anyone else's money. Payout data is the most sensitive thing
 * this plugin stores, and a multi-author blog is the normal case, not the edge case.
 *
 * Contributors get the own-wallet capability too. A contributor cannot publish, but their work
 * can still be published by an editor and earn — so they must be able to say where their money
 * goes without being handed any other power.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Roles {

	/** Connectivity, keys, enforcement switches. Administrator only. */
	const MANAGE_SETTINGS = 'naulon_manage_settings';

	/** Edit anyone's wallet. */
	const MANAGE_WALLETS = 'naulon_manage_wallets';

	/** Edit your own wallet. */
	const EDIT_OWN_WALLET = 'naulon_edit_own_wallet';

	/** Mark posts tolled/free, set per-post overrides. */
	const TOLL_POSTS = 'naulon_toll_posts';

	/** See the whole site's earnings. */
	const VIEW_EARNINGS_ALL = 'naulon_view_earnings_all';

	/** See your own earnings. */
	const VIEW_OWN_EARNINGS = 'naulon_view_own_earnings';

	/**
	 * The role → capability map. Kept as data so the admin screen can render exactly what is
	 * granted rather than describing it in prose that drifts.
	 *
	 * @return array<string, string[]>
	 */
	public static function map() {
		return array(
			'administrator' => array(
				self::MANAGE_SETTINGS,
				self::MANAGE_WALLETS,
				self::EDIT_OWN_WALLET,
				self::TOLL_POSTS,
				self::VIEW_EARNINGS_ALL,
				self::VIEW_OWN_EARNINGS,
			),
			'editor'        => array(
				self::MANAGE_WALLETS,
				self::EDIT_OWN_WALLET,
				self::TOLL_POSTS,
				self::VIEW_EARNINGS_ALL,
				self::VIEW_OWN_EARNINGS,
			),
			'author'        => array(
				self::EDIT_OWN_WALLET,
				self::TOLL_POSTS,
				self::VIEW_OWN_EARNINGS,
			),
			'contributor'   => array(
				self::EDIT_OWN_WALLET,
				self::VIEW_OWN_EARNINGS,
			),
		);
	}

	/**
	 * Grant the capabilities. Idempotent — activation may run many times.
	 *
	 * @return void
	 */
	public static function add_capabilities() {
		foreach ( self::map() as $role_name => $caps ) {
			$role = get_role( $role_name );
			if ( ! $role ) {
				continue; // a site may have removed a default role; that is their call.
			}
			foreach ( $caps as $cap ) {
				$role->add_cap( $cap );
			}
		}
	}

	/**
	 * Remove them. Uninstall only — deactivation keeps data and permissions intact so a
	 * publisher debugging something does not have to re-grant everything.
	 *
	 * @return void
	 */
	public static function remove_capabilities() {
		$all = array(
			self::MANAGE_SETTINGS,
			self::MANAGE_WALLETS,
			self::EDIT_OWN_WALLET,
			self::TOLL_POSTS,
			self::VIEW_EARNINGS_ALL,
			self::VIEW_OWN_EARNINGS,
		);
		foreach ( array_keys( self::map() ) as $role_name ) {
			$role = get_role( $role_name );
			if ( ! $role ) {
				continue;
			}
			foreach ( $all as $cap ) {
				$role->remove_cap( $cap );
			}
		}
	}

	/**
	 * May the current user edit this user's wallet? Own wallet with the own-capability, or
	 * anyone's with the manage capability. Nothing else.
	 *
	 * @param int $user_id Target user.
	 * @return bool
	 */
	public static function can_edit_wallet( $user_id ) {
		if ( current_user_can( self::MANAGE_WALLETS ) ) {
			return true;
		}
		return get_current_user_id() === (int) $user_id && current_user_can( self::EDIT_OWN_WALLET );
	}
}
