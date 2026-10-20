<?php
/**
 * The file types a publisher opted in, read off the policy's `gateScope`. Only whole-site scope
 * carries them, and only the four types the portal offers survive: anything else would route a
 * file type the control plane never prices into the toll.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class RulesFileTypesTest extends TestCase {

	public function test_site_scope_types_are_sorted() {
		$this->assertSame(
			array( 'pdf', 'xml' ),
			Naulon_Rules::valid_file_types(
				array(
					'mode'              => 'site',
					'excludePrefixes'   => array(),
					'includeExtensions' => array( 'xml', 'pdf' ),
				)
			)
		);
	}

	public function test_prefix_scope_carries_no_types() {
		$this->assertSame( array(), Naulon_Rules::valid_file_types( array( 'mode' => 'prefixes' ) ) );
	}

	public function test_absent_scope_carries_no_types() {
		$this->assertSame( array(), Naulon_Rules::valid_file_types( null ) );
	}

	public function test_unknown_types_are_dropped_and_case_folded() {
		$this->assertSame(
			array( 'pdf' ),
			Naulon_Rules::valid_file_types(
				array(
					'mode'              => 'site',
					'includeExtensions' => array( 'PDF', 'exe', 'pdf' ),
				)
			)
		);
	}

	public function test_malformed_extensions_carry_no_types() {
		$this->assertSame(
			array(),
			Naulon_Rules::valid_file_types(
				array(
					'mode'              => 'site',
					'includeExtensions' => 'pdf',
				)
			)
		);
	}
}
