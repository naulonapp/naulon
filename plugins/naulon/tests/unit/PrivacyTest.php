<?php
/**
 * The suggested privacy-policy text a site owner is offered under Settings → Privacy.
 *
 * What it must not do is understate: every piece of personal data the plugin can send to naulon
 * is named, including the two email addresses an author approval sends, which the readme's
 * External services section left out until 0.6.2.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class PrivacyTest extends TestCase {

	private function text() {
		return html_entity_decode( wp_strip_all_tags( Naulon_Privacy::policy_text() ), ENT_QUOTES, 'UTF-8' );
	}

	public function test_names_the_emails_an_author_approval_sends() {
		$this->assertStringContainsString( "the author's email address", $this->text() );
		$this->assertStringContainsString( 'email address of the person who approved', $this->text() );
	}

	public function test_names_the_wallet_addresses_a_payment_sends() {
		$this->assertStringContainsString( 'wallet addresses credited', $this->text() );
	}

	public function test_says_what_is_never_sent() {
		$this->assertStringContainsString( 'Visitors who read your site are never sent', $this->text() );
	}

	public function test_links_naulons_own_privacy_policy() {
		$this->assertStringContainsString( 'https://naulon.app/privacy', Naulon_Privacy::policy_text() );
	}
}
