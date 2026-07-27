<?php
/**
 * The payouts card on a user's own profile — the only naulon screen most authors will ever see.
 *
 * An author does not administer a toll. They answer one question: where should my money go? So
 * this is one field, the consequence of leaving it empty stated in plain words, and their own
 * earnings underneath it. No settings, no jargon, and nothing about anybody else.
 *
 * Two boundaries are enforced here rather than assumed:
 *
 * - **You may edit your own; an editor may edit anyone's.** The check runs against the user being
 *   edited, not the screen being viewed, because `user-edit.php` is the same screen pointed at
 *   somebody else.
 * - **An author never sees another author's money.** The earnings shown are queried by the
 *   wallet on the profile being viewed, and only when the viewer is allowed to see it.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Profile {

	const NONCE = 'naulon_profile_wallet';

	/** @var Naulon_Profile|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function register() {
		add_action( 'show_user_profile', array( $this, 'render' ) );
		add_action( 'edit_user_profile', array( $this, 'render' ) );
		add_action( 'personal_options_update', array( $this, 'save' ) );
		add_action( 'edit_user_profile_update', array( $this, 'save' ) );
	}

	/**
	 * The card.
	 *
	 * @param WP_User $user The user being viewed.
	 * @return void
	 */
	public function render( $user ) {
		if ( ! $user instanceof WP_User ) {
			return;
		}
		$editable = Naulon_Roles::can_edit_wallet( $user->ID );
		$wallet   = (string) get_user_meta( $user->ID, Naulon_Credits::USER_WALLET_META, true );
		$valid    = Naulon_Wallet::is_valid( $wallet );

		// Someone with no relationship to this plugin at all — no wallet, no permission — is
		// shown nothing rather than an empty section they cannot use.
		if ( ! $editable && ! $valid ) {
			return;
		}

		echo '<h2 id="naulon-payouts">' . esc_html__( 'naulon payouts', 'naulon' ) . '</h2>';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th><label for="naulon_wallet">' . esc_html__( 'Wallet address', 'naulon' ) . '</label></th><td>';
		if ( $editable ) {
			wp_nonce_field( self::NONCE, 'naulon_wallet_nonce' );
			// A native pattern, so a mistyped address is caught in the field rather than after a
			// round trip — and so the browser refuses to submit one. Empty stays valid: having no
			// wallet is a legitimate choice, and it means "my articles read free".
			printf(
				'<input type="text" class="regular-text code naulon-wallet" id="naulon_wallet" name="naulon_wallet" value="%1$s" placeholder="0x…" spellcheck="false" autocomplete="off" pattern="\s*0[xX][0-9a-fA-F]{40}\s*" title="%2$s" />',
				esc_attr( $wallet ),
				esc_attr__( 'A wallet address is 0x followed by 40 hex digits.', 'naulon' )
			);
			echo '<p class="description">';
			echo esc_html__( 'Where agents pay you when they read your articles. Payment goes straight from the buyer to this address — this site never holds it, so there is nothing to withdraw and nobody to trust with it.', 'naulon' );
			echo '</p>';
			if ( ! $valid ) {
				echo '<p class="description naulon-warn">' . esc_html__( 'You have no wallet set, so your articles read free. Nothing is charged for them and nothing is owed to you.', 'naulon' ) . '</p>';
			}
		} else {
			printf( '<code>%s</code>', esc_html( $wallet ) );
		}
		echo '</td></tr>';

		if ( $valid && $this->may_see_earnings( $user ) ) {
			echo '<tr><th>' . esc_html__( 'Earned so far', 'naulon' ) . '</th><td>';
			printf(
				'<strong>%s</strong> %s',
				esc_html( Naulon_Ledger::format_usdc( Naulon_Ledger::total_for_wallet( $wallet, Naulon_Ledger::STATUS_SETTLED ) ) ),
				esc_html__( 'USDC settled', 'naulon' )
			);
			$pending = Naulon_Ledger::total_for_wallet( $wallet, Naulon_Ledger::STATUS_PENDING );
			if ( $pending > 0 ) {
				printf(
					'<br /><span class="naulon-muted">%s %s</span>',
					esc_html( Naulon_Ledger::format_usdc( $pending ) ),
					esc_html__( 'USDC authorized and awaiting settlement', 'naulon' )
				);
			}
			printf(
				'<p class="description"><a href="%s">%s</a></p>',
				esc_url( admin_url( 'admin.php?page=' . Naulon_Admin::PAGE_EARNINGS ) ),
				esc_html__( 'See the payments', 'naulon' )
			);
			echo '</td></tr>';
		}

		echo '</tbody></table>';
	}

	/**
	 * May the current user see this profile's earnings?
	 *
	 * @param WP_User $user Profile being viewed.
	 * @return bool
	 */
	private function may_see_earnings( $user ) {
		if ( current_user_can( Naulon_Roles::VIEW_EARNINGS_ALL ) ) {
			return true;
		}
		return get_current_user_id() === (int) $user->ID && current_user_can( Naulon_Roles::VIEW_OWN_EARNINGS );
	}

	/**
	 * Save the wallet.
	 *
	 * A rejected address is reported through the standard profile error surface and the old value
	 * is kept: silently discarding what someone typed into a payout field is how money ends up at
	 * an address nobody chose.
	 *
	 * @param int $user_id The user being saved.
	 * @return void
	 */
	public function save( $user_id ) {
		if ( ! isset( $_POST['naulon_wallet_nonce'] ) ) {
			return;
		}
		if ( ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['naulon_wallet_nonce'] ) ), self::NONCE ) ) {
			return;
		}
		if ( ! Naulon_Roles::can_edit_wallet( $user_id ) ) {
			return;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified above.
		$raw = isset( $_POST['naulon_wallet'] ) ? trim( sanitize_text_field( wp_unslash( $_POST['naulon_wallet'] ) ) ) : '';

		if ( '' === $raw ) {
			delete_user_meta( $user_id, Naulon_Credits::USER_WALLET_META );
			return;
		}

		$reason = Naulon_Wallet::rejection_reason( $raw );
		if ( null !== $reason ) {
			Naulon_Admin::notice( 'error', $reason );
			return;
		}

		update_user_meta( $user_id, Naulon_Credits::USER_WALLET_META, Naulon_Wallet::normalize( $raw ) );
	}
}
