<?php
/**
 * Suggested privacy-policy text, offered to the site owner under Settings → Privacy.
 *
 * WordPress asks plugins that send personal data off the site to say so here, so a site owner can
 * copy it into their own policy. This plugin sends some: the wallet addresses credited on a paid
 * article, and — when an administrator or editor approves an author's request for a naulon payout
 * account — that author's email address and the approver's. The text names each one.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Privacy {

	/** @var Naulon_Privacy|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function register() {
		add_action( 'admin_init', array( $this, 'add_policy_content' ) );
	}

	public function add_policy_content() {
		if ( function_exists( 'wp_add_privacy_policy_content' ) ) {
			wp_add_privacy_policy_content( 'naulon', self::policy_text() );
		}
	}

	/**
	 * The policy text as HTML. Pure, so the unit suite can hold it to what the plugin actually sends.
	 *
	 * @return string
	 */
	public static function policy_text() {
		$items = array(
			__( 'When an automated agent pays to read an article: the article\'s address and the wallet addresses credited on it.', 'naulon' ),
			__( 'When an administrator or editor approves an author\'s request for a naulon payout account: the author\'s email address, the author\'s user number on this site, and the email address of the person who approved the request. naulon uses them to send the author an invitation.', 'naulon' ),
			__( 'To keep the connection working: this site\'s domain and its naulon API key.', 'naulon' ),
		);
		$html  = '<p>' . esc_html__( 'This site uses the naulon plugin to charge automated agents for reading articles and to pay the authors who wrote them. naulon (https://naulon.app) receives:', 'naulon' ) . '</p>';
		$html .= '<ul>';
		foreach ( $items as $item ) {
			$html .= '<li>' . esc_html( $item ) . '</li>';
		}
		$html .= '</ul>';
		$html .= '<p>' . esc_html__( 'Visitors who read your site are never sent: no visitor data, logs or content leave this site because of a human reading it.', 'naulon' ) . '</p>';
		$html .= '<p>' . sprintf(
			/* translators: %s: link to naulon's privacy policy */
			esc_html__( 'naulon\'s privacy policy: %s', 'naulon' ),
			'<a href="' . esc_url( 'https://naulon.app/privacy' ) . '">https://naulon.app/privacy</a>'
		) . '</p>';
		return wp_kses_post( $html );
	}
}
