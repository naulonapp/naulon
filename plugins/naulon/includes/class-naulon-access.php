<?php
/**
 * Author access requests — the bridge between a WordPress identity and a naulon payout account.
 *
 * The problem it solves is identity, not permission. An author already controls their own wallet
 * here (`Naulon_Roles::EDIT_OWN_WALLET` reaches contributors), and WordPress's user table is
 * already the roster. What is missing is the join key: naulon pays a contributor by `authorId`,
 * this site emits `wp-user-<ID>` (`Naulon_Credits::contributors_for`), and every other way that id
 * has been produced — an owner typing it, or naulon deriving it from an email — is a guess that
 * routes nothing when it misses.
 *
 * So the id travels from the only code that knows it. The author asks on their own profile, an
 * administrator approves on People, and the plugin sends naulon the exact id its own credits
 * endpoint emits, with the author's own address. Nobody transcribes anything.
 *
 * Two meta keys, no table. `requested` → the author asked; `invited` → naulon accepted the invite
 * and emailed them. Declining clears the request rather than recording a refusal: this is a request
 * to be paid, not a disciplinary record.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Access {

	/** When the author asked (unix seconds). Absent = never asked. */
	const REQUESTED_META = 'naulon_access_requested_at';

	/** 'requested' | 'invited'. Absent = no request outstanding. */
	const STATE_META = 'naulon_access_state';

	const STATE_REQUESTED = 'requested';
	const STATE_INVITED   = 'invited';

	/**
	 * The naulon author id for a WordPress user. The SAME expression `contributors_for` emits, and
	 * that is the whole point — a second spelling of it here would reintroduce the mismatch.
	 *
	 * @param int $user_id WordPress user id.
	 * @return string
	 */
	public static function author_id( $user_id ) {
		return 'wp-user-' . (int) $user_id;
	}

	/**
	 * @param int $user_id WordPress user id.
	 * @return string '' when nothing is outstanding.
	 */
	public static function state( $user_id ) {
		$state = get_user_meta( (int) $user_id, self::STATE_META, true );
		return is_string( $state ) ? $state : '';
	}

	/**
	 * Record a request. Idempotent — asking twice does not reset the clock, so an impatient author
	 * cannot move themselves up an administrator's list.
	 *
	 * @param int $user_id WordPress user id.
	 * @return void
	 */
	public static function request( $user_id ) {
		if ( '' !== self::state( $user_id ) ) {
			return;
		}
		update_user_meta( (int) $user_id, self::STATE_META, self::STATE_REQUESTED );
		update_user_meta( (int) $user_id, self::REQUESTED_META, time() );
	}

	/**
	 * Clear a request — a decline, or an author withdrawing.
	 *
	 * @param int $user_id WordPress user id.
	 * @return void
	 */
	public static function clear( $user_id ) {
		delete_user_meta( (int) $user_id, self::STATE_META );
		delete_user_meta( (int) $user_id, self::REQUESTED_META );
	}

	/**
	 * Approve: ask naulon to invite this user as an author of this site, paid as the id this site
	 * emits. Returns null on success, or a message to show the administrator.
	 *
	 * The failure is deliberately NOT swallowed. Everything else this plugin calls the control
	 * plane for degrades to serving the page; this one is a button an administrator just pressed,
	 * and silence would leave them re-pressing it.
	 *
	 * @param int $user_id  The author being approved.
	 * @param int $actor_id The administrator approving (their address names the invite).
	 * @return string|null
	 */
	public static function approve( $user_id, $actor_id ) {
		$user  = get_userdata( (int) $user_id );
		$actor = get_userdata( (int) $actor_id );
		if ( ! $user || ! is_email( $user->user_email ) ) {
			return __( 'That user has no email address, so there is nobody to invite.', 'naulon' );
		}
		if ( ! $actor || ! is_email( $actor->user_email ) ) {
			return __( 'Your own account has no email address, so the invitation could not say who sent it.', 'naulon' );
		}
		if ( '' === Naulon_Settings::api_key() ) {
			return __( 'This site is not connected to naulon yet. Finish Setup first, then approve.', 'naulon' );
		}

		$result = Naulon_Client::instance()->invite_author(
			$user->user_email,
			self::author_id( $user->ID ),
			$actor->user_email
		);
		if ( is_wp_error( $result ) ) {
			return $result->get_error_message();
		}

		update_user_meta( (int) $user_id, self::STATE_META, self::STATE_INVITED );
		return null;
	}
}
