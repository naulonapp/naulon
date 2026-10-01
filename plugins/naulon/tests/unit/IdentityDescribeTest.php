<?php
/**
 * The line Diagnostics adds to a crawler decision, so a publisher can see whether the address
 * behind a claim was checked and what it showed.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class IdentityDescribeTest extends TestCase {

	private function result( $check ) {
		return array(
			'check'  => $check,
			'claims' => array( array( 'operator_id' => 'google', 'operator' => 'Google', 'fragment' => 'googlebot', 'check' => $check ) ),
		);
	}

	public function test_each_check_reads_as_a_plain_sentence() {
		$this->assertSame( "address inside Google's published ranges", Naulon_Identity::describe( $this->result( 'ip-verified' ) ) );
		$this->assertSame( "address outside Google's published ranges", Naulon_Identity::describe( $this->result( 'forged' ) ) );
		$this->assertSame( 'address not checked (no usable client address or no current ranges for Google)', Naulon_Identity::describe( $this->result( 'unverified' ) ) );
		$this->assertSame( '', Naulon_Identity::describe( null ) );
	}
}
