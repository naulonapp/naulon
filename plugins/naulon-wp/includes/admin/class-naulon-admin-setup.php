<?php
/**
 * Setup — the screen a publisher lands on, and the only one they must finish.
 *
 * It is four steps in a fixed order, and the order is not cosmetic: each one is genuinely
 * required by the one after it.
 *
 *   1. Connect — a key (or a self-hosted gate URL). Nothing can be priced without it.
 *   2. Prove you own this domain. Without a stamped challenge the control plane answers
 *      "resource not owned by this key" when we try to settle, so a 402 issued here could never
 *      be completed. Enforcement stays locked until this passes.
 *   3. Point the control plane at this site's credits route. The plugin cannot do this itself —
 *      that endpoint is session-authenticated — so the screen says so and gives the exact URL to
 *      paste rather than silently doing nothing.
 *   4. Switch it on, and test it.
 *
 * The test is the point of the whole screen. It asks this site for one of its own articles while
 * presenting a crawler's user agent, over real HTTP, and shows what came back — the status, the
 * price, the chain, the payee. Every other line on this page is a claim; that one is evidence.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Admin_Setup {

	/**
	 * The screen.
	 *
	 * @return void
	 */
	public static function render() {
		$settings  = Naulon_Settings::all();
		$connected = Naulon_Settings::is_connected();
		$verified  = Naulon_Settings::is_verified();

		echo '<div class="wrap naulon-wrap">';
		Naulon_Admin::header( __( 'Setup', 'naulon' ) );
		echo '<p class="naulon-lede">' . esc_html__( 'Charge AI agents for reading your articles. Humans always read free, and your authors are paid directly — nothing is ever held on your behalf.', 'naulon' ) . '</p>';

		if ( ! Naulon_Verification::permalinks_ok() ) {
			printf(
				'<div class="notice notice-error"><p>%s <a href="%s">%s</a></p></div>',
				esc_html__( 'Permalinks are set to Plain, and nothing below will work until that changes. With plain permalinks your articles have no path in their URL, so there is nothing to identify them by — every article would read free, and the file that proves you own this domain cannot be served at all.', 'naulon' ),
				esc_url( admin_url( 'options-permalink.php' ) ),
				esc_html__( 'Change it in Settings → Permalinks.', 'naulon' )
			);
		}

		self::render_connection( $settings, $connected );
		self::render_ownership( $settings, $connected, $verified );
		self::render_credits_url( $settings );
		self::render_enforcement( $settings, $connected, $verified );
		self::render_test( $settings );

		echo '</div>';
	}

	/* --------------------------------------------------------------------------------------- */
	/* 1 — connection                                                                           */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @param array $settings  Settings.
	 * @param bool  $connected Whether a key or gate URL is in force.
	 * @return void
	 */
	private static function render_connection( array $settings, $connected ) {
		Naulon_Admin::card_open(
			__( 'Connect', 'naulon' ),
			array(
				'step'  => 1,
				'state' => $connected ? 'done' : 'current',
			)
		);

		$source   = Naulon_Settings::key_source();
		$gate_url = (string) $settings['gate_url'];

		echo '<div class="naulon-state">';
		if ( $connected ) {
			Naulon_Admin::pill( 'ok', __( 'Connected', 'naulon' ) );
			if ( '' !== $gate_url ) {
				printf( '<code class="naulon-token">%s</code>', esc_html( $gate_url ) );
				echo '<span class="naulon-muted">' . esc_html__( 'your own gate', 'naulon' ) . '</span>';
			} else {
				printf( '<code class="naulon-token">%s</code>', esc_html( Naulon_Key::mask( Naulon_Settings::api_key() ) ) );
				echo '<span class="naulon-muted">';
				echo 'constant' === $source
					? esc_html__( 'from wp-config.php', 'naulon' )
					: esc_html__( 'stored in this site’s database', 'naulon' );
				echo '</span>';
			}
			if ( 'option' === $source ) {
				Naulon_Admin::actions_open();
				Naulon_Admin::form_open( 'disconnect', Naulon_Admin::PAGE_SETUP );
				submit_button( __( 'Disconnect', 'naulon' ), 'link-delete', 'submit', false );
				Naulon_Admin::form_close();
				Naulon_Admin::actions_close();
			}
		} else {
			Naulon_Admin::pill( 'idle', __( 'Not connected', 'naulon' ) );
			echo '<span class="naulon-muted">' . esc_html__( 'Nothing is being charged.', 'naulon' ) . '</span>';
		}
		echo '</div>';

		if ( 'constant' === $source ) {
			echo '<p class="naulon-muted">' . esc_html__( 'The key comes from wp-config.php, which is the better place for it — it stays out of database exports and backups. Change it there.', 'naulon' ) . '</p>';
			Naulon_Admin::card_close();
			return;
		}

		Naulon_Admin::form_open( 'save_connection', Naulon_Admin::PAGE_SETUP );
		echo '<div class="naulon-field">';
		echo '<label for="naulon_connection">' . esc_html__( 'API key, or the address of your own gate', 'naulon' ) . '</label>';
		printf(
			'<input type="password" class="regular-text code" id="naulon_connection" name="naulon_connection" autocomplete="off" spellcheck="false" placeholder="%s" />',
			esc_attr( 'nln_live_…' )
		);
		submit_button( $connected ? __( 'Replace', 'naulon' ) : __( 'Connect', 'naulon' ), 'primary', 'submit', false );
		echo '</div>';
		echo '<p class="naulon-muted naulon-hint">' . esc_html__( 'Checked against the control plane before it is stored, so a typo cannot take a working toll offline. The key never leaves this server: it is not printed into any page, and no browser ever sees it.', 'naulon' ) . '</p>';
		Naulon_Admin::form_close();

		Naulon_Admin::card_close();
	}

	/**
	 * Store a pasted key or gate URL — but only after the control plane accepts it.
	 *
	 * @return void
	 */
	public static function save_connection() {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- the dispatcher checked it.
		$raw = isset( $_POST['naulon_connection'] ) ? trim( (string) wp_unslash( $_POST['naulon_connection'] ) ) : '';
		if ( '' === $raw ) {
			Naulon_Admin::notice( 'error', __( 'Enter a key or a gate URL.', 'naulon' ) );
			return;
		}

		if ( Naulon_Key::looks_like_key( $raw ) ) {
			$check = Naulon_Client::instance()->enforce_status( $raw, Naulon_Settings::DEFAULT_API_BASE );
			if ( ! self::accept_check( $check ) ) {
				return;
			}
			Naulon_Settings::update(
				array(
					'api_key'  => $raw,
					'gate_url' => '',
				)
			);
			Naulon_Admin::notice( 'success', __( 'Connected. The control plane accepted this key.', 'naulon' ) );
			Naulon_Cron::instance()->ensure_scheduled();
			return;
		}

		if ( Naulon_Key::looks_like_gate_url( $raw ) ) {
			$base  = untrailingslashit( $raw );
			$check = Naulon_Client::instance()->enforce_status( '', $base );
			// A self-hosted gate may legitimately answer 401/404 on a keyed status route while
			// still being the right address — what must not happen is storing an address nothing
			// answers at all.
			if ( 0 === $check['status'] ) {
				/* translators: %s: transport error. */
				Naulon_Admin::notice( 'error', sprintf( __( 'Nothing answered at that address: %s', 'naulon' ), $check['error'] ) );
				return;
			}
			Naulon_Settings::update(
				array(
					'gate_url' => $base,
					'api_key'  => '',
				)
			);
			Naulon_Admin::notice( 'success', __( 'Connected to your own gate.', 'naulon' ) );
			Naulon_Cron::instance()->ensure_scheduled();
			return;
		}

		Naulon_Admin::notice(
			'error',
			__( 'That is neither an API key (they start with nln_live_) nor a gate URL (https://…).', 'naulon' )
		);
	}

	/**
	 * Judge a validation call. A rejected key must be loud: a silently unconnected plugin serves
	 * everything free and looks fine.
	 *
	 * @param array $check Client response.
	 * @return bool
	 */
	private static function accept_check( array $check ) {
		if ( $check['ok'] ) {
			return true;
		}
		if ( 401 === $check['status'] ) {
			Naulon_Admin::notice( 'error', __( 'The control plane rejected that key (401). Nothing has been changed — the toll is still running on the key it had.', 'naulon' ) );
			return false;
		}
		if ( 403 === $check['status'] ) {
			Naulon_Admin::notice( 'error', __( 'That key is missing a scope this plugin needs (403). Issue one with tenant read and domain management.', 'naulon' ) );
			return false;
		}
		if ( 0 === $check['status'] ) {
			/* translators: %s: transport error. */
			Naulon_Admin::notice( 'error', sprintf( __( 'Could not reach the control plane to check that key: %s. Nothing has been changed.', 'naulon' ), $check['error'] ) );
			return false;
		}
		/* translators: %d: HTTP status. */
		Naulon_Admin::notice( 'error', sprintf( __( 'The control plane answered %d while checking that key. Nothing has been changed.', 'naulon' ), $check['status'] ) );
		return false;
	}

	/**
	 * Forget the connection. Enforcement goes off with it — enforcing without a control plane
	 * would mean issuing prices nobody can pay.
	 *
	 * @return void
	 */
	public static function disconnect() {
		Naulon_Settings::update(
			array(
				'api_key'        => '',
				'gate_url'       => '',
				'enforcement_on' => false,
			)
		);
		Naulon_Cron::instance()->unschedule();
		Naulon_Admin::notice( 'success', __( 'Disconnected. Nothing is being charged.', 'naulon' ) );
	}

	/* --------------------------------------------------------------------------------------- */
	/* 2 — ownership                                                                            */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @param array $settings  Settings.
	 * @param bool  $connected Connected.
	 * @param bool  $verified  Verified.
	 * @return void
	 */
	private static function render_ownership( array $settings, $connected, $verified ) {
		Naulon_Admin::card_open(
			__( 'Prove you own this site', 'naulon' ),
			array(
				'step'  => 2,
				'state' => $verified ? 'done' : ( $connected ? 'current' : 'todo' ),
			)
		);

		$host  = Naulon_Verification::host();
		$https = Naulon_Verification::is_https();

		echo '<div class="naulon-state">';
		if ( $verified ) {
			Naulon_Admin::pill( 'ok', __( 'Verified', 'naulon' ) );
			printf( '<code class="naulon-token">%s</code>', esc_html( $host ) );
			if ( '' !== (string) $settings['verified_at'] ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- when() escapes.
				echo '<span class="naulon-muted">' . Naulon_Admin::when( (string) $settings['verified_at'] ) . '</span>';
			}
		} else {
			Naulon_Admin::pill( 'warn', __( 'Not verified', 'naulon' ) );
			printf( '<code class="naulon-token">%s</code>', esc_html( $host ) );
		}
		echo '</div>';

		if ( ! $https ) {
			echo '<p class="naulon-bad">' . esc_html__( 'This site is served over http. The ownership check is https-only, so it cannot pass until the site has a certificate. Everything else on this page will work; verification will not.', 'naulon' ) . '</p>';
		}

		if ( ! $verified ) {
			echo '<p>' . esc_html__( 'This plugin serves the proof itself — both as a file under /.well-known/ and as a tag in the page head — so there is no DNS to edit. Start it, then ask the control plane to look.', 'naulon' ) . '</p>';
		}

		if ( ! $connected ) {
			echo '<p class="naulon-muted">' . esc_html__( 'Connect first — verification is a conversation with the control plane.', 'naulon' ) . '</p>';
			Naulon_Admin::card_close();
			return;
		}

		Naulon_Admin::actions_open();
		Naulon_Admin::form_open( 'verify_start', Naulon_Admin::PAGE_SETUP );
		submit_button(
			'' === (string) $settings['challenge_token'] ? __( 'Verify this site', 'naulon' ) : __( 'Start again', 'naulon' ),
			$verified ? 'secondary' : 'primary',
			'submit',
			false
		);
		Naulon_Admin::form_close();

		if ( '' !== (string) $settings['challenge_token'] ) {
			Naulon_Admin::form_open( 'verify_check', Naulon_Admin::PAGE_SETUP );
			submit_button( __( 'Check now', 'naulon' ), $verified ? 'secondary' : 'primary', 'submit', false );
			Naulon_Admin::form_close();
		}
		Naulon_Admin::actions_close();

		if ( '' !== (string) $settings['challenge_token'] ) {
			printf(
				'<p class="naulon-muted naulon-hint">%s <code class="naulon-token">%s</code></p>',
				esc_html__( 'Serving the proof at', 'naulon' ),
				esc_html( Naulon_Challenge::challenge_url( (string) $settings['challenge_token'] ) )
			);
		}

		$diagnosis = Naulon_Admin::take( 'verify_diagnosis' );
		if ( is_array( $diagnosis ) && ! empty( $diagnosis['findings'] ) ) {
			echo '<div class="naulon-diagnosis"><h3>' . esc_html__( 'What this site can see from here', 'naulon' ) . '</h3><ul>';
			foreach ( $diagnosis['findings'] as $finding ) {
				echo '<li>' . esc_html( (string) $finding ) . '</li>';
			}
			echo '</ul></div>';
		}

		Naulon_Admin::card_close();
	}

	/**
	 * Open a challenge and start serving it.
	 *
	 * @return void
	 */
	public static function verify_start() {
		$result = Naulon_Verification::start();
		Naulon_Admin::notice( $result['ok'] ? 'success' : 'error', $result['message'] );
		if ( $result['ok'] && '' !== $result['token'] ) {
			// Ask immediately: the common case verifies on the first try, and one click is the
			// whole promise of this path.
			self::verify_check();
		}
	}

	/**
	 * Ask the control plane to look.
	 *
	 * @return void
	 */
	public static function verify_check() {
		$result = Naulon_Verification::complete();
		Naulon_Admin::notice( $result['ok'] ? 'success' : 'warning', $result['message'] );
		if ( ! $result['ok'] && ! empty( $result['diagnosis'] ) ) {
			Naulon_Admin::carry( 'verify_diagnosis', array( 'findings' => $result['diagnosis'] ) );
		}
	}

	/* --------------------------------------------------------------------------------------- */
	/* 3 — the credits URL the control plane must be pointed at                                 */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @param array $settings Settings.
	 * @return void
	 */
	private static function render_credits_url( array $settings ) {
		Naulon_Admin::card_open(
			__( 'Point your account at this site', 'naulon' ),
			array(
				'step'  => 3,
				'state' => Naulon_Settings::is_verified() ? 'current' : 'todo',
			)
		);
		echo '<p>' . esc_html__( 'This plugin publishes who wrote each article and where their money goes. The control plane has to be told to read it — that is a setting on your account, and one this plugin deliberately cannot change for you. Paste this address into the credits field there:', 'naulon' ) . '</p>';
		printf(
			'<p><input type="text" class="large-text code naulon-copyable" readonly onfocus="this.select()" value="%s" /></p>',
			esc_attr( rest_url( Naulon_Credits::NAMESPACE_V1 . '/credits/' ) )
		);
		echo '<p class="naulon-muted">' . esc_html__( 'An article that is not tollable — a draft, one with no author wallet, one you marked free — answers 404 here, which is the agreed signal for "read this one free". That is why nothing else needs a list of what is paid.', 'naulon' ) . '</p>';

		if ( '' !== trim( (string) $settings['credits_token'] ) ) {
			echo '<p class="naulon-muted">' . esc_html__( 'A shared token is set, so the control plane must send it. Remove it on the Content screen if the two ever disagree.', 'naulon' ) . '</p>';
		}
		Naulon_Admin::card_close();
	}

	/* --------------------------------------------------------------------------------------- */
	/* 4 — the switch                                                                           */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @param array $settings  Settings.
	 * @param bool  $connected Connected.
	 * @param bool  $verified  Verified.
	 * @return void
	 */
	private static function render_enforcement( array $settings, $connected, $verified ) {
		$on        = ! empty( $settings['enforcement_on'] );
		$ready     = $connected && $verified;
		$conflict  = 'conflict' === (string) $settings['status_mode'];
		$enforcing = Naulon_Enforcer::instance()->is_active();

		Naulon_Admin::card_open(
			__( 'Switch the toll on', 'naulon' ),
			array(
				'step'  => 4,
				'state' => $enforcing ? 'done' : ( $ready ? 'current' : 'todo' ),
			)
		);

		echo '<div class="naulon-state">';
		if ( $enforcing ) {
			Naulon_Admin::pill( 'ok', __( 'Charging agents', 'naulon' ) );
		} elseif ( $on && $conflict ) {
			Naulon_Admin::pill( 'bad', __( 'Standing down', 'naulon' ) );
		} elseif ( $on ) {
			Naulon_Admin::pill( 'warn', __( 'On, but not able to charge', 'naulon' ) );
		} else {
			Naulon_Admin::pill( 'idle', __( 'Off', 'naulon' ) );
		}
		echo '</div>';

		if ( $conflict ) {
			echo '<p class="naulon-bad">' . esc_html__( 'Your DNS still points this domain at the hosted gate, and the gate is already charging for it. Enforcing here as well would charge the same read twice, so this plugin has stood down. Remove the CNAME, or leave enforcement off and let the gate do it.', 'naulon' ) . '</p>';
		}

		if ( ! $ready ) {
			echo '<p class="naulon-muted">';
			echo $connected
				? esc_html__( 'Verification has to pass first. Until it does, the control plane will not settle a payment for this domain — so a price shown here could never actually be paid.', 'naulon' )
				: esc_html__( 'Connect first.', 'naulon' );
			echo '</p>';
		}

		Naulon_Admin::form_open( 'toggle_enforcement', Naulon_Admin::PAGE_SETUP );
		printf( '<input type="hidden" name="naulon_enforcement" value="%s" />', $on ? '0' : '1' );
		if ( $on ) {
			submit_button( __( 'Switch off', 'naulon' ), 'secondary', 'submit', false );
		} else {
			submit_button(
				__( 'Switch on', 'naulon' ),
				'primary',
				'submit',
				false,
				$ready ? array() : array( 'disabled' => 'disabled' )
			);
		}
		Naulon_Admin::form_close();

		echo '<p class="naulon-muted">' . esc_html__( 'Humans are never affected by this switch. It decides whether machines are charged.', 'naulon' ) . '</p>';
		Naulon_Admin::card_close();
	}

	/**
	 * Flip the switch — refusing to switch on while it could not be honored.
	 *
	 * @return void
	 */
	public static function toggle_enforcement() {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- the dispatcher checked it.
		$wanted = isset( $_POST['naulon_enforcement'] ) && '1' === (string) wp_unslash( $_POST['naulon_enforcement'] );

		if ( $wanted && ! ( Naulon_Settings::is_connected() && Naulon_Settings::is_verified() ) ) {
			Naulon_Admin::notice( 'error', __( 'Not yet. Connect and verify first — a toll that cannot be settled is worse than no toll.', 'naulon' ) );
			return;
		}

		Naulon_Settings::update( array( 'enforcement_on' => $wanted ) );
		Naulon_Admin::notice(
			'success',
			$wanted
				? __( 'The toll is on. Agents are charged; readers are not.', 'naulon' )
				: __( 'The toll is off. Everything reads free.', 'naulon' )
		);
	}

	/* --------------------------------------------------------------------------------------- */
	/* The test                                                                                 */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * @param array $settings Settings.
	 * @return void
	 */
	private static function render_test( array $settings ) {
		Naulon_Admin::card_open( __( 'Test the toll', 'naulon' ) );
		echo '<p>' . esc_html__( 'This asks your own site for one of your articles while pretending to be a crawler, over real HTTP, and shows exactly what came back.', 'naulon' ) . '</p>';

		Naulon_Admin::actions_open();
		Naulon_Admin::form_open( 'test_toll', Naulon_Admin::PAGE_SETUP );
		submit_button( __( 'Test toll', 'naulon' ), 'secondary', 'submit', false );
		Naulon_Admin::form_close();
		Naulon_Admin::form_open( 'refresh_status', Naulon_Admin::PAGE_SETUP );
		submit_button( __( 'Check status', 'naulon' ), 'secondary', 'submit', false );
		Naulon_Admin::form_close();
		Naulon_Admin::actions_close();

		$result = Naulon_Admin::take( 'test_toll' );
		if ( is_array( $result ) ) {
			self::render_test_result( $result );
		}

		// The one nudge worth making from this screen. A live toll on a cached site under-charges
		// with nothing to show for it: no error, no slow page, just crawlers reading free off a
		// cached copy. Only shown once the toll is actually running, so it never nags a site that
		// has not started.
		$dropin = Naulon_Cache::dropin_state();
		if ( Naulon_Enforcer::instance()->is_active() && ! $dropin['installed'] ) {
			printf(
				'<p class="naulon-warn naulon-hint">%s <a href="%s">%s</a></p>',
				esc_html__( 'The toll is running, but the cache guard is not installed. If anything caches pages on this site, crawlers may be reading them free without any sign of it here.', 'naulon' ),
				esc_url( admin_url( 'admin.php?page=' . Naulon_Admin::PAGE_DIAGNOSTICS ) ),
				esc_html__( 'Install it on the Diagnostics screen.', 'naulon' )
			);
		}

		$status_line = self::status_line( $settings );
		if ( '' !== $status_line ) {
			echo '<p class="naulon-muted naulon-hint">' . esc_html( $status_line ) . '</p>';
		}

		Naulon_Admin::card_close();
	}

	/**
	 * Render what the probe actually got.
	 *
	 * @param array $result Probe result plus the decoded challenge.
	 * @return void
	 */
	private static function render_test_result( array $result ) {
		$verdict = isset( $result['verdict'] ) ? (string) $result['verdict'] : '';

		echo '<div class="naulon-result naulon-result--' . esc_attr( $verdict ) . '">';
		echo '<div class="naulon-state">';
		if ( 'enforcing' === $verdict ) {
			Naulon_Admin::pill( 'ok', __( 'Charged', 'naulon' ) );
		} elseif ( 'under_tolling' === $verdict ) {
			Naulon_Admin::pill( 'bad', __( 'Served free', 'naulon' ) );
		} else {
			Naulon_Admin::pill( 'warn', __( 'Inconclusive', 'naulon' ) );
		}
		if ( ! empty( $result['status'] ) ) {
			printf( '<code class="naulon-token">HTTP %d</code>', (int) $result['status'] );
		}
		if ( ! empty( $result['url'] ) ) {
			printf( '<span class="naulon-muted naulon-truncate">%s</span>', esc_html( (string) $result['url'] ) );
		}
		echo '</div>';

		if ( ! empty( $result['message'] ) ) {
			echo '<p>' . esc_html( (string) $result['message'] ) . '</p>';
		}

		if ( ! empty( $result['challenge_decoded'] ) && is_array( $result['challenge_decoded'] ) ) {
			self::render_challenge( $result['challenge_decoded'] );
		}

		if ( ! empty( $result['headers'] ) && is_array( $result['headers'] ) ) {
			echo '<table class="naulon-kv"><tbody>';
			foreach ( $result['headers'] as $name => $value ) {
				printf(
					'<tr><th>%s</th><td><code>%s</code></td></tr>',
					esc_html( (string) $name ),
					esc_html( (string) $value )
				);
			}
			echo '</tbody></table>';
		}
		echo '</div>';
	}

	/**
	 * The decoded 402 — the price, the chain, the payee. The trust moment.
	 *
	 * @param array $decoded Decoded PAYMENT-REQUIRED body.
	 * @return void
	 */
	private static function render_challenge( array $decoded ) {
		$accepts = isset( $decoded['accepts'][0] ) && is_array( $decoded['accepts'][0] ) ? $decoded['accepts'][0] : array();
		if ( empty( $accepts ) ) {
			return;
		}

		echo '<table class="naulon-kv"><tbody>';
		printf(
			'<tr><th>%s</th><td><strong>%s USDC</strong></td></tr>',
			esc_html__( 'Price', 'naulon' ),
			esc_html( Naulon_Ledger::format_usdc( isset( $accepts['amount'] ) ? $accepts['amount'] : 0 ) )
		);
		printf(
			'<tr><th>%s</th><td><code>%s</code></td></tr>',
			esc_html__( 'Paid to', 'naulon' ),
			esc_html( isset( $accepts['payTo'] ) ? (string) $accepts['payTo'] : '' )
		);
		printf(
			'<tr><th>%s</th><td><code>%s</code></td></tr>',
			esc_html__( 'Chain', 'naulon' ),
			esc_html( isset( $accepts['network'] ) ? (string) $accepts['network'] : '' )
		);

		if ( isset( $decoded['extensions']['naulonLegs']['legs'] ) && is_array( $decoded['extensions']['naulonLegs']['legs'] ) ) {
			$legs  = $decoded['extensions']['naulonLegs']['legs'];
			$lines = array();
			foreach ( $legs as $leg ) {
				$lines[] = sprintf(
					'%s → %s USDC',
					isset( $leg['payTo'] ) ? (string) $leg['payTo'] : '',
					Naulon_Ledger::format_usdc( isset( $leg['amount'] ) ? $leg['amount'] : 0 )
				);
			}
			printf(
				'<tr><th>%s</th><td>%s</td></tr>',
				esc_html__( 'Split', 'naulon' ),
				esc_html( implode( ' · ', $lines ) )
			);
		}
		echo '</tbody></table>';
	}

	/**
	 * Run the test.
	 *
	 * @return void
	 */
	public static function test_toll() {
		$result = Naulon_Cache::probe();

		if ( ! empty( $result['challenge'] ) ) {
			$decoded = Naulon_Ledger::decode_402( (string) $result['challenge'] );
			if ( is_array( $decoded ) ) {
				$result['challenge_decoded'] = $decoded;
			}
			unset( $result['challenge'] );
		}

		Naulon_Admin::carry( 'test_toll', $result );

		// Terse here: the detail is rendered right below the button, and a notice repeating it
		// word for word just makes the screen say everything twice.
		if ( 'enforcing' === $result['verdict'] ) {
			Naulon_Admin::notice( 'success', __( 'A crawler was charged for that article.', 'naulon' ) );
			return;
		}
		if ( 'under_tolling' === $result['verdict'] ) {
			Naulon_Admin::notice( 'warning', __( 'A crawler read that article free — see the detail below.', 'naulon' ) );
			return;
		}
		Naulon_Admin::notice( 'warning', (string) $result['message'] );
	}

	/**
	 * Refresh the control plane's classification of this host, on demand.
	 *
	 * @return void
	 */
	public static function refresh_status() {
		$status = Naulon_Cron::instance()->refresh_status();
		if ( ! $status['ok'] ) {
			Naulon_Admin::notice( 'error', $status['message'] );
			return;
		}
		Naulon_Admin::notice(
			'success',
			'' === $status['mode']
				/* translators: the control plane has no verdict for this host yet. */
				? __( 'The control plane has not classified this domain yet.', 'naulon' )
				/* translators: %s: enforcement mode. */
				: sprintf( __( 'The control plane sees this domain as: %s', 'naulon' ), $status['mode'] )
		);
	}

	/**
	 * One line describing the last status check.
	 *
	 * @param array $settings Settings.
	 * @return string
	 */
	private static function status_line( array $settings ) {
		$checked = (string) $settings['status_checked_at'];
		if ( '' === $checked ) {
			return '';
		}
		if ( '' !== (string) $settings['status_error'] ) {
			return (string) $settings['status_error'];
		}
		$mode = (string) $settings['status_mode'];
		if ( '' === $mode ) {
			/* translators: %s: timestamp. */
			return sprintf( __( 'Checked %s: this domain is not classified yet.', 'naulon' ), $checked );
		}
		/* translators: 1: timestamp, 2: enforcement mode. */
		return sprintf( __( 'Checked %1$s: the control plane sees this domain as %2$s.', 'naulon' ), $checked, $mode );
	}
}
