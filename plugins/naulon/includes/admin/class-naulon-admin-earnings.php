<?php
/**
 * Earnings — what this site was actually paid.
 *
 * Every figure here is read straight out of the ledger, which stores the amounts the control
 * plane put in the 402 the buyer signed against. Nothing on this screen is computed from a price
 * and a share; there is no arithmetic here beyond the database's own SUM over integer columns.
 *
 * Two states a publisher must be able to tell apart, so they are shown separately rather than
 * added together:
 *
 *   **Settled** — the money moved. It is on chain.
 *   **Authorized** — a co-author's share the buyer has signed for, which settles when the
 *   deferred sweep runs. Real, but not yet landed.
 *
 * Rolling those two into one "total earned" would be the friendlier number and the dishonest one.
 *
 * An author who is not allowed to see the whole site's money sees only their own, resolved from
 * their own wallet address. That is enforced here by what is queried, not by what is displayed.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Admin_Earnings {

	/**
	 * The screen.
	 *
	 * @return void
	 */
	public static function render() {
		$all = current_user_can( Naulon_Roles::VIEW_EARNINGS_ALL );

		echo '<div class="wrap naulon-wrap">';
		Naulon_Admin::header( __( 'Earnings', 'naulon' ) );

		if ( $all ) {
			self::render_site_totals();
			self::render_by_author();
			self::render_recent( Naulon_Ledger::recent( 25 ) );
		} else {
			self::render_own();
		}

		echo '</div>';
	}

	/**
	 * @return void
	 */
	private static function render_site_totals() {
		$settled = Naulon_Ledger::site_total( Naulon_Ledger::STATUS_SETTLED );
		$pending = Naulon_Ledger::site_total( Naulon_Ledger::STATUS_PENDING );

		Naulon_Admin::card_open( __( 'This site', 'naulon' ) );
		echo '<div class="naulon-figures">';
		printf(
			'<div class="naulon-figure"><span class="naulon-figure__value naulon-num">%s</span><span class="naulon-figure__label">%s</span></div>',
			esc_html( Naulon_Ledger::format_usdc( $settled ) ),
			esc_html__( 'USDC settled', 'naulon' )
		);
		printf(
			'<div class="naulon-figure"><span class="naulon-figure__value naulon-num">%s</span><span class="naulon-figure__label">%s</span></div>',
			esc_html( Naulon_Ledger::format_usdc( $pending ) ),
			esc_html__( 'USDC authorized, awaiting settlement', 'naulon' )
		);
		printf(
			'<div class="naulon-figure"><span class="naulon-figure__value naulon-num">%s</span><span class="naulon-figure__label">%s</span></div>',
			esc_html( number_format_i18n( Naulon_Ledger::settlement_count() ) ),
			esc_html__( 'payments', 'naulon' )
		);
		echo '</div>';
		echo '<p class="naulon-muted">' . esc_html__( 'Money moves from the buyer to the author directly. This site never holds it, and neither does anybody else — there is no balance to withdraw, because there is no pot.', 'naulon' ) . '</p>';
		Naulon_Admin::card_close();
	}

	/**
	 * @return void
	 */
	private static function render_by_author() {
		$rows = Naulon_Ledger::totals_by_wallet( 50 );

		Naulon_Admin::card_open( __( 'By author', 'naulon' ) );
		if ( empty( $rows ) ) {
			echo '<p class="naulon-muted">' . esc_html__( 'Nothing yet. The first payment will show up here the moment an agent pays for an article.', 'naulon' ) . '</p>';
			Naulon_Admin::card_close();
			return;
		}

		echo '<table class="widefat striped naulon-table"><thead><tr>';
		printf( '<th>%s</th>', esc_html__( 'Author', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Wallet', 'naulon' ) );
		printf( '<th class="naulon-num">%s</th>', esc_html__( 'Settled', 'naulon' ) );
		printf( '<th class="naulon-num">%s</th>', esc_html__( 'Authorized', 'naulon' ) );
		echo '</tr></thead><tbody>';

		foreach ( $rows as $row ) {
			$wallet = isset( $row['pay_to'] ) ? (string) $row['pay_to'] : '';
			$user   = self::user_for_wallet( $wallet );
			echo '<tr>';
			printf(
				'<td>%s</td>',
				$user instanceof WP_User
					? esc_html( $user->display_name )
					/* A payee with no matching user is normal: a site fallback, or an author who
					   changed their wallet after being paid. Never guess who it was. */
					: '<span class="naulon-muted">' . esc_html__( 'not a user on this site', 'naulon' ) . '</span>'
			);
			printf( '<td><code class="naulon-truncate">%s</code></td>', esc_html( $wallet ) );
			printf( '<td class="naulon-num">%s</td>', esc_html( Naulon_Ledger::format_usdc( isset( $row['settled'] ) ? $row['settled'] : 0 ) ) );
			printf( '<td class="naulon-num">%s</td>', esc_html( Naulon_Ledger::format_usdc( isset( $row['pending'] ) ? $row['pending'] : 0 ) ) );
			echo '</tr>';
		}
		echo '</tbody></table>';
		Naulon_Admin::card_close();
	}

	/**
	 * The author's own view. Queried by their wallet, so there is nothing to leak.
	 *
	 * @return void
	 */
	private static function render_own() {
		$wallet = (string) get_user_meta( get_current_user_id(), Naulon_Credits::USER_WALLET_META, true );

		Naulon_Admin::card_open( __( 'Your earnings', 'naulon' ) );
		if ( ! Naulon_Wallet::is_valid( $wallet ) ) {
			printf(
				'<p>%s <a href="%s">%s</a></p>',
				esc_html__( 'You have not set a wallet, so your posts read free and nothing is paid for them.', 'naulon' ),
				esc_url( admin_url( 'profile.php#naulon-payouts' ) ),
				esc_html__( 'Set one on your profile.', 'naulon' )
			);
			Naulon_Admin::card_close();
			return;
		}

		echo '<div class="naulon-figures">';
		printf(
			'<div class="naulon-figure"><span class="naulon-figure__value naulon-num">%s</span><span class="naulon-figure__label">%s</span></div>',
			esc_html( Naulon_Ledger::format_usdc( Naulon_Ledger::total_for_wallet( $wallet, Naulon_Ledger::STATUS_SETTLED ) ) ),
			esc_html__( 'USDC settled', 'naulon' )
		);
		printf(
			'<div class="naulon-figure"><span class="naulon-figure__value naulon-num">%s</span><span class="naulon-figure__label">%s</span></div>',
			esc_html( Naulon_Ledger::format_usdc( Naulon_Ledger::total_for_wallet( $wallet, Naulon_Ledger::STATUS_PENDING ) ) ),
			esc_html__( 'USDC authorized, awaiting settlement', 'naulon' )
		);
		echo '</div>';
		printf( '<p class="naulon-muted">%s <code>%s</code></p>', esc_html__( 'Paid to', 'naulon' ), esc_html( $wallet ) );
		Naulon_Admin::card_close();

		self::render_recent( Naulon_Ledger::recent( 25, $wallet ) );
	}

	/**
	 * @param array[] $rows Ledger rows.
	 * @return void
	 */
	private static function render_recent( array $rows ) {
		Naulon_Admin::card_open( __( 'Recent payments', 'naulon' ) );
		if ( empty( $rows ) ) {
			echo '<p class="naulon-muted">' . esc_html__( 'Nothing yet.', 'naulon' ) . '</p>';
			Naulon_Admin::card_close();
			return;
		}

		echo '<table class="widefat striped naulon-table"><thead><tr>';
		printf( '<th>%s</th>', esc_html__( 'When', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Article', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'Kind', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'To', 'naulon' ) );
		printf( '<th class="naulon-num">%s</th>', esc_html__( 'USDC', 'naulon' ) );
		printf( '<th>%s</th>', esc_html__( 'State', 'naulon' ) );
		echo '</tr></thead><tbody>';

		foreach ( $rows as $row ) {
			$post_id = isset( $row['post_id'] ) ? (int) $row['post_id'] : 0;
			$title   = $post_id > 0 ? get_the_title( $post_id ) : '';
			echo '<tr>';
			// Stored in GMT, shown as "how long ago" with the exact local time on hover: a
			// publisher reads this column to answer "is this still happening?", not to audit a
			// timestamp — and a raw GMT string in a site set to another timezone reads as wrong.
			$stamp = isset( $row['settled_at'] ) ? strtotime( (string) $row['settled_at'] . ' UTC' ) : false;
			printf(
				'<td><span title="%s">%s</span></td>',
				esc_attr( false !== $stamp ? wp_date( 'Y-m-d H:i', $stamp ) : '' ),
				esc_html(
					false !== $stamp
						/* translators: %s: human time difference, e.g. "2 hours". */
						? sprintf( __( '%s ago', 'naulon' ), human_time_diff( $stamp ) )
						: ''
				)
			);
			printf(
				'<td>%s</td>',
				'' !== $title
					? esc_html( $title )
					: esc_html( isset( $row['slug'] ) ? (string) $row['slug'] : '' )
			);
			printf( '<td>%s</td>', esc_html( isset( $row['kind'] ) ? (string) $row['kind'] : '' ) );
			printf( '<td><code class="naulon-truncate">%s</code></td>', esc_html( isset( $row['pay_to'] ) ? (string) $row['pay_to'] : '' ) );
			printf( '<td class="naulon-num">%s</td>', esc_html( Naulon_Ledger::format_usdc( isset( $row['amount_atomic'] ) ? $row['amount_atomic'] : 0 ) ) );
			printf(
				'<td>%s</td>',
				esc_html(
					Naulon_Ledger::STATUS_SETTLED === ( isset( $row['status'] ) ? $row['status'] : '' )
						? __( 'settled', 'naulon' )
						: __( 'authorized', 'naulon' )
				)
			);
			echo '</tr>';
		}
		echo '</tbody></table>';
		Naulon_Admin::card_close();
	}

	/**
	 * Which user, if any, owns a payee address.
	 *
	 * @param string $wallet Address.
	 * @return WP_User|null
	 */
	private static function user_for_wallet( $wallet ) {
		if ( ! Naulon_Wallet::is_valid( $wallet ) ) {
			return null;
		}
		$users = get_users(
			array(
				'meta_key'   => Naulon_Credits::USER_WALLET_META, // phpcs:ignore WordPress.DB.SlowDBQuery -- indexed meta lookup, admin screen only.
				'meta_value' => Naulon_Wallet::normalize( $wallet ), // phpcs:ignore WordPress.DB.SlowDBQuery
				'number'     => 1,
			)
		);
		return ( is_array( $users ) && isset( $users[0] ) ) ? $users[0] : null;
	}
}
