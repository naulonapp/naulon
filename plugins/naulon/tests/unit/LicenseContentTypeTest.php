<?php
/**
 * The licence is labelled for its reader: RSL for a crawler, plain XML for a browser.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class LicenseContentTypeTest extends TestCase {

	public function test_a_browser_is_shown_xml() {
		$this->assertSame(
			'application/xml; charset=utf-8',
			Naulon_License::content_type( 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' )
		);
	}

	public function test_a_crawler_keeps_the_rsl_type() {
		foreach ( array( '', '*/*', 'application/rsl+xml', 'application/rsl+xml, application/xml;q=0.9', 'text/html, application/rsl+xml' ) as $accept ) {
			$this->assertSame( 'application/rsl+xml; charset=utf-8', Naulon_License::content_type( $accept ), $accept );
		}
	}
}
