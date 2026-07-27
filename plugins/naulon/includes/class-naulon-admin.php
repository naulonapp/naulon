<?php
/**
 * The admin controller — menu, form handling, notices.
 *
 * Every screen in this plugin is a thin renderer over machinery that already exists and is
 * already tested. That is deliberate: nothing on an admin screen may decide anything about money
 * or about who gets charged. A button here starts a verification, flips a switch, or asks the
 * site a question over HTTP — the answers come from the same code paths a real request uses.
 *
 * Three rules hold for every form on every screen:
 *
 * - **Post, redirect, get.** Handlers live behind `admin-post.php`, and every one of them ends in
 *   a redirect. A publisher who refreshes after clicking "verify" must not re-run it.
 * - **A capability check per action, not per screen.** Being able to see a screen is not
 *   permission to act on it; each branch of the dispatcher checks the capability its own action
 *   requires, on top of the nonce.
 * - **Results are shown, not summarized.** When a check fails, the screen shows what came back —
 *   the status, the bytes, the header — because "verification failed" is useless to the person
 *   who has to fix it.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Admin {

	/** Top-level menu + Setup screen. */
	const PAGE_SETUP = 'naulon';

	const PAGE_CONTENT = 'naulon-content';

	const PAGE_PEOPLE = 'naulon-people';

	const PAGE_EARNINGS = 'naulon-earnings';

	const PAGE_DIAGNOSTICS = 'naulon-diagnostics';

	/** The single admin-post action; the specific action rides in a field. */
	const ACTION = 'naulon_admin';

	/** @var Naulon_Admin|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function register() {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
		add_action( 'admin_init', array( $this, 'admin_init' ) );
		add_action( 'admin_post_' . self::ACTION, array( $this, 'handle' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue' ) );
		add_action( 'admin_notices', array( $this, 'print_notices' ) );
	}

	/**
	 * Keep the ledger schema current, and nothing else. Admin-side only: a reader's request must
	 * never pay for a schema check.
	 *
	 * @return void
	 */
	public function admin_init() {
		Naulon_Ledger::maybe_install();
	}

	/**
	 * The menu.
	 *
	 * The top level asks for the settings capability, but WordPress promotes the first submenu a
	 * user CAN reach — so an editor sees the menu land on People, and an author on Earnings, each
	 * without ever being shown a screen they may not use.
	 *
	 * @return void
	 */
	public function add_menu() {
		add_menu_page(
			__( 'naulon', 'naulon' ),
			__( 'naulon', 'naulon' ),
			Naulon_Roles::MANAGE_SETTINGS,
			self::PAGE_SETUP,
			array( $this, 'render_setup' ),
			self::menu_icon(),
			58
		);
		add_submenu_page(
			self::PAGE_SETUP,
			__( 'Setup', 'naulon' ),
			__( 'Setup', 'naulon' ),
			Naulon_Roles::MANAGE_SETTINGS,
			self::PAGE_SETUP,
			array( $this, 'render_setup' )
		);
		add_submenu_page(
			self::PAGE_SETUP,
			__( 'Content', 'naulon' ),
			__( 'Content', 'naulon' ),
			Naulon_Roles::MANAGE_SETTINGS,
			self::PAGE_CONTENT,
			array( $this, 'render_content' )
		);
		add_submenu_page(
			self::PAGE_SETUP,
			__( 'People', 'naulon' ),
			__( 'People', 'naulon' ),
			Naulon_Roles::MANAGE_WALLETS,
			self::PAGE_PEOPLE,
			array( $this, 'render_people' )
		);
		add_submenu_page(
			self::PAGE_SETUP,
			__( 'Earnings', 'naulon' ),
			__( 'Earnings', 'naulon' ),
			Naulon_Roles::VIEW_OWN_EARNINGS,
			self::PAGE_EARNINGS,
			array( $this, 'render_earnings' )
		);
		add_submenu_page(
			self::PAGE_SETUP,
			__( 'Diagnostics', 'naulon' ),
			__( 'Diagnostics', 'naulon' ),
			Naulon_Roles::MANAGE_SETTINGS,
			self::PAGE_DIAGNOSTICS,
			array( $this, 'render_diagnostics' )
		);
	}

	/**
	 * Our screens only — no plugin has any business loading assets on someone else's page.
	 *
	 * @param string $hook Current admin page hook.
	 * @return void
	 */
	public function enqueue( $hook ) {
		if ( false === strpos( (string) $hook, 'naulon' ) && 'profile.php' !== $hook && 'user-edit.php' !== $hook ) {
			return;
		}
		wp_enqueue_style(
			'naulon-admin',
			plugins_url( 'assets/admin.css', NAULON_PLUGIN_FILE ),
			array(),
			NAULON_VERSION
		);
	}

	/* --------------------------------------------------------------------------------------- */
	/* Screens                                                                                  */
	/* --------------------------------------------------------------------------------------- */

	public function render_setup() {
		$this->guard( Naulon_Roles::MANAGE_SETTINGS );
		Naulon_Admin_Setup::render();
	}

	public function render_content() {
		$this->guard( Naulon_Roles::MANAGE_SETTINGS );
		Naulon_Admin_Content::render();
	}

	public function render_people() {
		$this->guard( Naulon_Roles::MANAGE_WALLETS );
		Naulon_Admin_People::render();
	}

	public function render_earnings() {
		$this->guard( Naulon_Roles::VIEW_OWN_EARNINGS );
		Naulon_Admin_Earnings::render();
	}

	public function render_diagnostics() {
		$this->guard( Naulon_Roles::MANAGE_SETTINGS );
		Naulon_Admin_Diagnostics::render();
	}

	/**
	 * Refuse to render a screen to someone who may not see it. WordPress already hides the menu
	 * item; this is the check that matters, because a menu item is not a permission system.
	 *
	 * @param string $capability Required capability.
	 * @return void
	 */
	private function guard( $capability ) {
		if ( ! current_user_can( $capability ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'naulon' ), 403 );
		}
	}

	/* --------------------------------------------------------------------------------------- */
	/* Form handling                                                                            */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * Every form on every screen lands here.
	 *
	 * @return void
	 */
	public function handle() {
		$action = isset( $_POST['naulon_action'] ) ? sanitize_key( wp_unslash( $_POST['naulon_action'] ) ) : '';
		check_admin_referer( 'naulon_' . $action );

		switch ( $action ) {
			case 'save_connection':
				$this->require_cap( Naulon_Roles::MANAGE_SETTINGS );
				Naulon_Admin_Setup::save_connection();
				break;
			case 'disconnect':
				$this->require_cap( Naulon_Roles::MANAGE_SETTINGS );
				Naulon_Admin_Setup::disconnect();
				break;
			case 'verify_start':
				$this->require_cap( Naulon_Roles::MANAGE_SETTINGS );
				Naulon_Admin_Setup::verify_start();
				break;
			case 'verify_check':
				$this->require_cap( Naulon_Roles::MANAGE_SETTINGS );
				Naulon_Admin_Setup::verify_check();
				break;
			case 'toggle_enforcement':
				$this->require_cap( Naulon_Roles::MANAGE_SETTINGS );
				Naulon_Admin_Setup::toggle_enforcement();
				break;
			case 'test_toll':
				$this->require_cap( Naulon_Roles::MANAGE_SETTINGS );
				Naulon_Admin_Setup::test_toll();
				break;
			case 'refresh_status':
				$this->require_cap( Naulon_Roles::MANAGE_SETTINGS );
				Naulon_Admin_Setup::refresh_status();
				break;
			case 'save_content':
				$this->require_cap( Naulon_Roles::MANAGE_SETTINGS );
				Naulon_Admin_Content::save();
				break;
			case 'save_wallet':
				// The capability check for a wallet is per-target-user, not per-screen: an editor
				// may edit anyone's, an author only their own. Naulon_Roles owns that rule.
				Naulon_Admin_People::save_wallet();
				break;
			case 'install_dropin':
			case 'remove_dropin':
			case 'run_probe':
			case 'clear_log':
				$this->require_cap( Naulon_Roles::MANAGE_SETTINGS );
				Naulon_Admin_Diagnostics::handle( $action );
				break;
			default:
				self::notice( 'error', __( 'Unknown action.', 'naulon' ) );
		}

		$this->redirect_back();
	}

	/**
	 * @param string $capability Required capability.
	 * @return void
	 */
	private function require_cap( $capability ) {
		if ( ! current_user_can( $capability ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'naulon' ), 403 );
		}
	}

	/**
	 * Back to the screen the form was posted from, never to an arbitrary URL.
	 *
	 * @return void
	 */
	private function redirect_back() {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- handle() ran check_admin_referer before dispatching; this only picks which of our own screens to return to, and the value is validated against an allowlist below.
		$page  = isset( $_POST['naulon_page'] ) ? sanitize_key( wp_unslash( $_POST['naulon_page'] ) ) : self::PAGE_SETUP;
		$allow = array( self::PAGE_SETUP, self::PAGE_CONTENT, self::PAGE_PEOPLE, self::PAGE_EARNINGS, self::PAGE_DIAGNOSTICS );
		if ( ! in_array( $page, $allow, true ) ) {
			$page = self::PAGE_SETUP;
		}
		wp_safe_redirect( admin_url( 'admin.php?page=' . $page ) );
		exit;
	}

	/* --------------------------------------------------------------------------------------- */
	/* Notices + carried results                                                                */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * Queue a notice for this user's next page load.
	 *
	 * @param string $type    success|error|warning|info.
	 * @param string $message Message text (already translated).
	 * @return void
	 */
	public static function notice( $type, $message ) {
		$key      = self::notice_key();
		$existing = get_transient( $key );
		$existing = is_array( $existing ) ? $existing : array();
		$existing[] = array(
			'type'    => $type,
			'message' => $message,
		);
		set_transient( $key, $existing, 120 );
	}

	/**
	 * Carry a structured result (a diagnosis, a decoded 402) across the redirect, so the screen
	 * can render the real bytes rather than a summary.
	 *
	 * @param string $name   Result name.
	 * @param array  $result The result.
	 * @return void
	 */
	public static function carry( $name, array $result ) {
		set_transient( self::result_key( $name ), $result, 300 );
	}

	/**
	 * Read and clear a carried result.
	 *
	 * @param string $name Result name.
	 * @return array|null
	 */
	public static function take( $name ) {
		$key   = self::result_key( $name );
		$value = get_transient( $key );
		if ( ! is_array( $value ) ) {
			return null;
		}
		delete_transient( $key );
		return $value;
	}

	/**
	 * Print and clear queued notices.
	 *
	 * @return void
	 */
	public function print_notices() {
		$key      = self::notice_key();
		$notices  = get_transient( $key );
		if ( ! is_array( $notices ) || empty( $notices ) ) {
			return;
		}
		delete_transient( $key );
		foreach ( $notices as $notice ) {
			$type = isset( $notice['type'] ) ? (string) $notice['type'] : 'info';
			printf(
				'<div class="notice notice-%1$s"><p>%2$s</p></div>',
				esc_attr( in_array( $type, array( 'success', 'error', 'warning', 'info' ), true ) ? $type : 'info' ),
				esc_html( isset( $notice['message'] ) ? $notice['message'] : '' )
			);
		}
	}

	/**
	 * @return string
	 */
	private static function notice_key() {
		return 'naulon_notices_' . get_current_user_id();
	}

	/**
	 * @param string $name Result name.
	 * @return string
	 */
	private static function result_key( $name ) {
		return 'naulon_result_' . sanitize_key( $name ) . '_' . get_current_user_id();
	}

	/* --------------------------------------------------------------------------------------- */
	/* Brand                                                                                    */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * The naulon mark: an arch with a point under it — a toll gate, and the coin passing through.
	 * Inline rather than an <img> so it inherits `currentColor` and stays crisp in the admin
	 * menu, in the page header, and on a high-density screen alike.
	 *
	 * @return string SVG markup.
	 */
	public static function mark_svg() {
		return '<svg class="naulon-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">'
			. '<path d="M5.5 19.5V11a6.5 6.5 0 0 1 13 0v8.5" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>'
			. '<circle cx="12" cy="13.2" r="1.85" fill="currentColor"/></svg>';
	}

	/**
	 * The same mark as a data URI for the admin menu. Fixed to the admin menu's own icon grey:
	 * WordPress fades and brightens menu icons with opacity rather than recolouring them, so a
	 * neutral grey is what reads as native in every admin colour scheme.
	 *
	 * @return string
	 */
	public static function menu_icon() {
		$svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">'
			. '<path d="M5.5 19.5V11a6.5 6.5 0 0 1 13 0v8.5" stroke="#a7aaad" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>'
			. '<circle cx="12" cy="13.2" r="1.85" fill="#a7aaad"/></svg>';
		return 'data:image/svg+xml;base64,' . base64_encode( $svg ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions -- a data URI is the documented format for a menu icon.
	}

	/**
	 * The header every naulon screen opens with: the mark, the page name, and the four facts that
	 * decide whether this site earns anything.
	 *
	 * The state strip repeats on every screen deliberately. Someone reading the Earnings page and
	 * seeing nothing needs to know, without navigating, that the toll is switched off — the
	 * answer to "why is this empty" is almost always up here.
	 *
	 * @param string $title Page title.
	 * @return void
	 */
	public static function header( $title ) {
		$settings  = Naulon_Settings::all();
		$connected = Naulon_Settings::is_connected();
		$verified  = Naulon_Settings::is_verified();
		$enforcing = Naulon_Enforcer::instance()->is_active();
		$switch_on = ! empty( $settings['enforcement_on'] );

		echo '<div class="naulon-head">';
		echo '<div class="naulon-head__brand">';
		echo '<span class="naulon-head__logo">' . self::mark_svg() . '</span>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- static markup from mark_svg().
		echo '<span class="naulon-head__name">naulon</span>';
		echo '<span class="naulon-head__sep" aria-hidden="true"></span>';
		printf( '<span class="naulon-head__page">%s</span>', esc_html( $title ) );
		echo '</div>';

		echo '<div class="naulon-head__state">';
		self::state_item(
			$connected ? 'ok' : 'idle',
			__( 'Connection', 'naulon' ),
			$connected ? __( 'connected', 'naulon' ) : __( 'none', 'naulon' )
		);
		self::state_item(
			$verified ? 'ok' : 'warn',
			__( 'Domain', 'naulon' ),
			$verified ? __( 'verified', 'naulon' ) : __( 'unproven', 'naulon' )
		);
		self::state_item(
			$enforcing ? 'ok' : ( $switch_on ? 'bad' : 'idle' ),
			__( 'Toll', 'naulon' ),
			$enforcing ? __( 'charging agents', 'naulon' ) : ( $switch_on ? __( 'blocked', 'naulon' ) : __( 'off', 'naulon' ) )
		);
		self::state_item(
			'idle',
			__( 'Paid out', 'naulon' ),
			Naulon_Ledger::format_usdc( Naulon_Ledger::site_total() ) . ' USDC'
		);
		echo '</div>';
		echo '</div>';
	}

	/**
	 * One fact in the header strip.
	 *
	 * @param string $state ok|warn|bad|idle.
	 * @param string $label What it is.
	 * @param string $value What it says.
	 * @return void
	 */
	private static function state_item( $state, $label, $value ) {
		printf(
			'<div class="naulon-head__item"><span class="naulon-head__label">%1$s</span>'
				. '<span class="naulon-head__value"><span class="naulon-dot naulon-dot--%2$s"></span>%3$s</span></div>',
			esc_html( $label ),
			esc_attr( $state ),
			esc_html( $value )
		);
	}

	/* --------------------------------------------------------------------------------------- */
	/* Render helpers — used by every screen                                                    */
	/* --------------------------------------------------------------------------------------- */

	/**
	 * Open a form that posts to the dispatcher.
	 *
	 * @param string $action Action name.
	 * @param string $page   Page to return to.
	 * @return void
	 */
	public static function form_open( $action, $page ) {
		printf( '<form method="post" action="%s">', esc_url( admin_url( 'admin-post.php' ) ) );
		wp_nonce_field( 'naulon_' . $action );
		printf( '<input type="hidden" name="action" value="%s" />', esc_attr( self::ACTION ) );
		printf( '<input type="hidden" name="naulon_action" value="%s" />', esc_attr( $action ) );
		printf( '<input type="hidden" name="naulon_page" value="%s" />', esc_attr( $page ) );
	}

	/**
	 * @return void
	 */
	public static function form_close() {
		echo '</form>';
	}

	/**
	 * A status pill: a one-word state with a colour, used everywhere a screen states a fact.
	 *
	 * @param string $state ok|warn|bad|idle.
	 * @param string $label Text.
	 * @return void
	 */
	public static function pill( $state, $label ) {
		printf(
			'<span class="naulon-pill naulon-pill--%1$s">%2$s</span>',
			esc_attr( $state ),
			esc_html( $label )
		);
	}

	/**
	 * Section wrapper — a card with a heading, optionally numbered as a setup step.
	 *
	 * A step carries its own state: done, current, or waiting. Setup is a sequence where each
	 * step genuinely blocks the next, so showing which one you are on is not decoration — it is
	 * the difference between "four boxes" and "here is what is left".
	 *
	 * @param string $title Heading.
	 * @param array  $args  {
	 *     @type int    $step  Step number, or 0 for a plain card.
	 *     @type string $state done|current|todo.
	 * }
	 * @return void
	 */
	public static function card_open( $title, array $args = array() ) {
		$step  = isset( $args['step'] ) ? (int) $args['step'] : 0;
		$state = isset( $args['state'] ) ? (string) $args['state'] : '';

		printf( '<div class="naulon-card%s">', $step > 0 ? ' naulon-card--step naulon-card--' . esc_attr( $state ) : '' );

		if ( '' === $title ) {
			return;
		}
		if ( $step > 0 ) {
			printf(
				'<h2><span class="naulon-step" aria-hidden="true">%s</span>%s</h2>',
				'done' === $state ? '&#10003;' : esc_html( (string) $step ),
				esc_html( $title )
			);
			return;
		}
		printf( '<h2>%s</h2>', esc_html( $title ) );
	}

	/**
	 * @return void
	 */
	public static function card_close() {
		echo '</div>';
	}

	/**
	 * A stored timestamp as "3 minutes ago", with the exact local time on hover.
	 *
	 * Every timestamp this plugin stores is UTC, and every question a publisher asks about one is
	 * relative — "is this still running?", "when did it last work?". A raw ISO string in a site
	 * set to another timezone reads as wrong even when it is right.
	 *
	 * @param string $iso      Stored timestamp (any strtotime-parseable UTC form).
	 * @param string $fallback Shown when there is no timestamp.
	 * @return string HTML.
	 */
	public static function when( $iso, $fallback = '' ) {
		$iso = trim( (string) $iso );
		if ( '' === $iso ) {
			return esc_html( $fallback );
		}
		$stamp = strtotime( $iso );
		if ( false === $stamp ) {
			return esc_html( $iso );
		}
		return sprintf(
			'<span title="%s">%s</span>',
			esc_attr( wp_date( 'Y-m-d H:i T', $stamp ) ),
			esc_html(
				/* translators: %s: human time difference, e.g. "2 hours". */
				sprintf( __( '%s ago', 'naulon' ), human_time_diff( $stamp ) )
			)
		);
	}

	/**
	 * A row of buttons. Each button is its own form (they post different actions), so without
	 * this they stack awkwardly instead of sitting side by side.
	 *
	 * @return void
	 */
	public static function actions_open() {
		echo '<div class="naulon-actions">';
	}

	/**
	 * @return void
	 */
	public static function actions_close() {
		echo '</div>';
	}
}
