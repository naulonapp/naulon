<?php
class DiagnosticsIdentityTest extends WP_UnitTestCase {
	public function test_an_allowlisted_crawler_is_not_called_a_person() {
		$this->assertSame(
			'allowed crawler (matched "googlebot"); address inside Google\'s published ranges',
			Naulon_Admin_Diagnostics::reason_label( 'human (seo allowlist matched "googlebot"); address inside Google\'s published ranges' )
		);
		$this->assertSame( 'human (browser-shaped)', Naulon_Admin_Diagnostics::reason_label( 'human (browser-shaped)' ) );
	}

	public function test_the_armed_line_names_companies_once_or_says_what_it_waits_for() {
		$this->assertSame( 'Google, Microsoft', Naulon_Admin_Diagnostics::armed_line( array( 'google', 'bing' ) ) );
		$this->assertSame( 'OpenAI', Naulon_Admin_Diagnostics::armed_line( array( 'openai-gptbot', 'openai-searchbot' ) ) );
		$this->assertStringContainsString( '20', Naulon_Admin_Diagnostics::armed_line( array() ) );
	}
}
