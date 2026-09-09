<?php
/**
 * People — who can be paid, and who cannot be yet.
 *
 * The number that matters on this screen is the second one. An author without a wallet HERE is
 * still credited on the credits route — named with no address — because the service this site
 * connects to may hold a payout address for them and fill the leg. What it costs is certainty:
 * only that service can say whether those posts earn, and if nothing holds an address for them
 * the post reads free. A site can be fully connected, verified and switched on and still earn
 * nothing, and this is the screen that says who that depends on.
 *
 * The rule underneath every wallet field here is the one from the credits contract: a
 * contributor with no usable wallet is dropped, never substituted. Nobody's article is ever paid
 * to somebody else's address because that address happened to be handy.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Admin_People {

	/** How many users the roster loads. Beyond this, the site is a publication with a directory. */
	const MAX_USERS = 200;

	/**
	 * The screen.
	 *
	 * @return void
	 */
	public static function render() {
		$users = self::roster();

		echo '<div class="wrap naulon-wrap">';
		Naulon_Admin::header( __( 'People', 'naulon' ) );

		self::render_summary( $users );
		self::render_table( $users );
		self::render_capabilities();

		echo '</div>';
	}

	/**
	 * Everyone who can write here.
	 *
	 * @return WP_User[]
	 */
	private static function roster() {
		$users = get_users(
			array(
				'capability' => 'edit_posts',
				'number'     => self::MAX_USERS,
				'orderby'    => 'display_name',
				'order'      => 'ASC',
			)
		);
		return is_array( $users ) ? $users : array();
	}

	/**
	 * @param WP_User[] $users Roster.
	 * @return void
	 */
	private static function render_summary( array $users ) {
		$without = 0;
		foreach ( $users as $user ) {
			if ( ! Naulon_Wallet::is_valid( get_user_meta( $user->ID, Naulon_Credits::USER_WALLET_META, true ) ) ) {
				++$without;
			}
		}

		$counts = Naulon_Admin_Content::scope_counts( Naulon_Credits::instance() );

		Naulon_Admin::card_open( '' );
		echo '<p class="naulon-state">';
		if ( 0 === $without ) {
			Naulon_Admin::pill( 'ok', __( 'Everyone can be paid', 'naulon' ) );
		} else {
			Naulon_Admin::pill( 'warn', __( 'Some authors have no wallet here', 'naulon' ) );
			// "reads free" is no longer knowable from this site alone: an author with a naulon
			// payout account is paid to their own wallet even with none set here. So this counts
			// what it can see — no wallet HERE, and the posts that depend on one.
			printf(
				' %s',
				esc_html(
					sprintf(
						/* translators: 1: number of authors, 2: number of posts. */
						_n(
							'%1$d author has no wallet here, and %2$d published post depends on one.',
							'%1$d authors have no wallet here, and %2$d published posts depend on one.',
							$without,
							'naulon'
						),
						$without,
						$counts['no_wallet']
					)
				)
			);
		}
		echo '</p>';
		Naulon_Admin::card_close();
	}

	/**
	 * @param WP_User[] $users Roster.
	 * @return void
	 */
	private static function render_table( array $users ) {
		Naulon_Admin::card_open( __( 'Wallets', 'naulon' ) );
		echo '<table class="widefat striped naulon-table"><thead><tr>';
		printf( '<th>%s</th>', esc_html__( 'Author', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Role', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Wallet', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'naulon account', 'naulon' ) );
		printf( '<th class="naulon-num">%s</th>', esc_html__( 'Published', 'naulon' ) );
		printf( '<th class="naulon-num">%s</th>', esc_html__( 'Earned (USDC)', 'naulon' ) );
		echo '</tr></thead><tbody>';

		foreach ( $users as $user ) {
			$wallet = (string) get_user_meta( $user->ID, Naulon_Credits::USER_WALLET_META, true );
			$valid  = Naulon_Wallet::is_valid( $wallet );

			echo '<tr>';
			printf(
				'<td><strong>%s</strong><br /><span class="naulon-muted">%s</span></td>',
				esc_html( $user->display_name ),
				esc_html( $user->user_login )
			);
			printf( '<td>%s</td>', esc_html( implode( ', ', (array) $user->roles ) ) );

			echo '<td>';
			if ( Naulon_Roles::can_edit_wallet( $user->ID ) ) {
				Naulon_Admin::form_open( 'save_wallet', Naulon_Admin::PAGE_PEOPLE );
				printf( '<input type="hidden" name="naulon_user" value="%d" />', (int) $user->ID );
				printf(
					'<input type="text" class="code naulon-wallet-input naulon-wallet" name="naulon_wallet" value="%1$s" placeholder="0x…" spellcheck="false" pattern="\s*0[xX][0-9a-fA-F]{40}\s*" title="%2$s" />',
					esc_attr( $wallet ),
					esc_attr__( 'A wallet address is 0x followed by 40 hex digits.', 'naulon' )
				);
				submit_button( __( 'Save', 'naulon' ), 'small', 'submit', false );
				Naulon_Admin::form_close();
			} elseif ( $valid ) {
				printf( '<code>%s</code>', esc_html( $wallet ) );
			} else {
				echo '<span class="naulon-muted">' . esc_html__( 'none', 'naulon' ) . '</span>';
			}
			if ( ! $valid ) {
				echo '<div class="naulon-warn">' . esc_html__( 'No wallet here.', 'naulon' ) . '</div>';
			}
			echo '</td>';

			echo '<td>';
			self::render_access_cell( $user );
			echo '</td>';

			printf( '<td class="naulon-num">%s</td>', esc_html( number_format_i18n( (int) count_user_posts( $user->ID, 'post', true ) ) ) );
			printf(
				'<td class="naulon-num">%s</td>',
				esc_html( $valid ? Naulon_Ledger::format_usdc( Naulon_Ledger::total_for_wallet( $wallet ) ) : '—' )
			);
			echo '</tr>';
		}

		echo '</tbody></table>';
		echo '<p class="naulon-muted">' . esc_html__( 'Authors can set their own wallet on their profile page. Nobody can see anyone else’s earnings unless their role allows it.', 'naulon' ) . '</p>';
		Naulon_Admin::card_close();
	}

	/**
	 * What each role may do — rendered from the map itself, so it cannot describe something the
	 * code does not actually grant.
	 *
	 * @return void
	 */
	private static function render_capabilities() {
		Naulon_Admin::card_open( __( 'Who may do what', 'naulon' ) );
		echo '<table class="widefat striped naulon-table"><thead><tr>';
		printf( '<th>%s</th>', esc_html__( 'Role', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Granted', 'naulon' ) );
		echo '</tr></thead><tbody>';
		foreach ( Naulon_Roles::map() as $role => $caps ) {
			printf( '<tr><td><strong>%s</strong></td><td><div class="naulon-tags">', esc_html( $role ) );
			foreach ( $caps as $cap ) {
				printf( '<span class="naulon-tag">%s</span>', esc_html( $cap ) );
			}
			echo '</div></td></tr>';
		}
		echo '</tbody></table>';
		Naulon_Admin::card_close();
	}

	/**
	 * Save one wallet.
	 *
	 * The capability check is per target user, not per screen: an editor may set anyone's, an
	 * author only their own. An empty value clears the wallet, which is a legitimate choice — it
	 * means "my posts read free" — and is not treated as an error.
	 *
	 * @return void
	 */
	/**
	 * The request lane: an author asked for a naulon payout account, an administrator answers.
	 *
	 * Approving sends naulon the payee id THIS site emits (`wp-user-<ID>`), so the id never has to
	 * be transcribed by anyone. Every other way it has been produced — an owner typing it into the
	 * portal, or naulon deriving one from an email — is a guess, and a wrong guess routes nothing
	 * while looking correct on both sides.
	 *
	 * @param WP_User $user The roster row.
	 * @return void
	 */
	private static function render_access_cell( $user ) {
		$state = Naulon_Access::state( $user->ID );

		if ( Naulon_Access::STATE_INVITED === $state ) {
			echo '<span class="naulon-muted">' . esc_html__( 'Invited', 'naulon' ) . '</span>';
			return;
		}
		if ( Naulon_Access::STATE_REQUESTED !== $state ) {
			echo '<span class="naulon-muted">' . esc_html__( '—', 'naulon' ) . '</span>';
			return;
		}
		if ( ! current_user_can( Naulon_Roles::MANAGE_WALLETS ) ) {
			echo '<span class="naulon-muted">' . esc_html__( 'Requested', 'naulon' ) . '</span>';
			return;
		}

		Naulon_Admin::form_open( 'approve_access', Naulon_Admin::PAGE_PEOPLE );
		printf( '<input type="hidden" name="naulon_user" value="%d" />', (int) $user->ID );
		submit_button( __( 'Approve', 'naulon' ), 'small primary', 'submit', false );
		Naulon_Admin::form_close();
		Naulon_Admin::form_open( 'decline_access', Naulon_Admin::PAGE_PEOPLE );
		printf( '<input type="hidden" name="naulon_user" value="%d" />', (int) $user->ID );
		submit_button( __( 'Decline', 'naulon' ), 'small', 'submit', false );
		Naulon_Admin::form_close();
	}

	/**
	 * Approve a request: ask naulon to invite them, paid as the id this site emits.
	 *
	 * @return void
	 */
	public static function approve_access() {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- the dispatcher checked it.
		$user_id = isset( $_POST['naulon_user'] ) ? (int) $_POST['naulon_user'] : 0;
		if ( $user_id <= 0 || ! get_userdata( $user_id ) ) {
			Naulon_Admin::notice( 'error', __( 'No such user.', 'naulon' ) );
			return;
		}
		if ( ! current_user_can( Naulon_Roles::MANAGE_WALLETS ) ) {
			wp_die( esc_html__( 'You do not have permission to approve payout accounts.', 'naulon' ), 403 );
		}
		if ( Naulon_Access::STATE_REQUESTED !== Naulon_Access::state( $user_id ) ) {
			Naulon_Admin::notice( 'error', __( 'There is no outstanding request for that user.', 'naulon' ) );
			return;
		}

		$error = Naulon_Access::approve( $user_id, get_current_user_id() );
		if ( null !== $error ) {
			Naulon_Admin::notice( 'error', $error );
			return;
		}
		Naulon_Admin::notice( 'success', __( 'Approved. naulon has emailed them an invitation.', 'naulon' ) );
	}

	/**
	 * Decline a request — it is cleared, not recorded. This is a request to be paid, not a file.
	 *
	 * @return void
	 */
	public static function decline_access() {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- the dispatcher checked it.
		$user_id = isset( $_POST['naulon_user'] ) ? (int) $_POST['naulon_user'] : 0;
		if ( ! current_user_can( Naulon_Roles::MANAGE_WALLETS ) ) {
			wp_die( esc_html__( 'You do not have permission to approve payout accounts.', 'naulon' ), 403 );
		}
		if ( $user_id > 0 ) {
			Naulon_Access::clear( $user_id );
		}
		Naulon_Admin::notice( 'success', __( 'Request cleared.', 'naulon' ) );
	}

	public static function save_wallet() {
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- the dispatcher checked it.
		$user_id = isset( $_POST['naulon_user'] ) ? (int) $_POST['naulon_user'] : 0;
		$raw     = isset( $_POST['naulon_wallet'] ) ? trim( sanitize_text_field( wp_unslash( $_POST['naulon_wallet'] ) ) ) : '';
		// phpcs:enable WordPress.Security.NonceVerification.Missing

		if ( $user_id <= 0 || ! get_userdata( $user_id ) ) {
			Naulon_Admin::notice( 'error', __( 'No such user.', 'naulon' ) );
			return;
		}
		if ( ! Naulon_Roles::can_edit_wallet( $user_id ) ) {
			wp_die( esc_html__( 'You do not have permission to change that wallet.', 'naulon' ), 403 );
		}

		if ( '' === $raw ) {
			delete_user_meta( $user_id, Naulon_Credits::USER_WALLET_META );
			Naulon_Admin::notice( 'success', __( 'Wallet cleared. Their posts now read free.', 'naulon' ) );
			return;
		}

		$reason = Naulon_Wallet::rejection_reason( $raw );
		if ( null !== $reason ) {
			Naulon_Admin::notice( 'error', $reason );
			return;
		}

		update_user_meta( $user_id, Naulon_Credits::USER_WALLET_META, Naulon_Wallet::normalize( $raw ) );
		Naulon_Admin::notice( 'success', __( 'Wallet saved.', 'naulon' ) );
	}
}
