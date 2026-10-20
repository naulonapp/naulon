<?php
/**
 * The self-test's verdict from what the site and its three probe requests showed. Only an echo of
 * the nonce sent with THAT request counts as PHP answering it; cache headers alone never decide.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class FileProbeClassifyTest extends TestCase {

	private function env( array $over = array() ) {
		return array_merge(
			array(
				'multisite' => false,
				'offloaded' => false,
				'written'   => true,
			),
			$over
		);
	}

	private function reply( $sent, $echo, $code = 200, $cache = '' ) {
		return array(
			'code'  => $code,
			'sent'  => $sent,
			'echo'  => $echo,
			'cache' => $cache,
		);
	}

	private function ok_a() {
		return $this->reply( 'a', 'a' );
	}

	public function test_multisite_is_unsupported() {
		$this->assertSame( 'unsupported', Naulon_File_Probe::classify( $this->env( array( 'multisite' => true ) ), null, null, null )['status'] );
	}

	public function test_offloaded_uploads() {
		$this->assertSame( 'offloaded', Naulon_File_Probe::classify( $this->env( array( 'offloaded' => true ) ), null, null, null )['status'] );
	}

	public function test_unwritten_rule_without_echo_is_not_writable() {
		$this->assertSame( 'not_writable', Naulon_File_Probe::classify( $this->env( array( 'written' => false ) ), $this->reply( 'a', null ), null, null )['status'] );
	}

	public function test_unwritten_rule_with_echo_is_fine() {
		// Somebody pasted the block (or an nginx rule) by hand: what matters is that it routes.
		$verdict = Naulon_File_Probe::classify( $this->env( array( 'written' => false ) ), $this->ok_a(), $this->reply( 'b', 'b' ), $this->reply( 'c', 'c' ) );
		$this->assertSame( 'ok', $verdict['status'] );
	}

	public function test_auth_wall_is_unsupported_with_its_code() {
		$verdict = Naulon_File_Probe::classify( $this->env(), $this->reply( 'a', null, 401 ), null, null );
		$this->assertSame( 'unsupported', $verdict['status'] );
		$this->assertStringContainsString( '401', $verdict['detail'] );
	}

	public function test_transport_error_is_unsupported() {
		$verdict = Naulon_File_Probe::classify( $this->env(), $this->reply( 'a', null, 0 ), null, null );
		$this->assertSame( 'unsupported', $verdict['status'] );
	}

	public function test_no_echo_is_no_rewrite() {
		$this->assertSame( 'no_rewrite', Naulon_File_Probe::classify( $this->env(), $this->reply( 'a', null ), null, null )['status'] );
	}

	public function test_fresh_echo_on_the_repeat_is_ok() {
		$verdict = Naulon_File_Probe::classify( $this->env(), $this->ok_a(), $this->reply( 'b', 'b' ), $this->reply( 'c', 'c', 200, 'DYNAMIC' ) );
		$this->assertSame( 'ok', $verdict['status'] );
	}

	public function test_replayed_echo_is_cached_and_names_the_cache() {
		$verdict = Naulon_File_Probe::classify( $this->env(), $this->ok_a(), $this->reply( 'b', 'b' ), $this->reply( 'c', 'b', 200, 'Cloudflare (HIT)' ) );
		$this->assertSame( 'cached', $verdict['status'] );
		$this->assertStringContainsString( 'Cloudflare', $verdict['detail'] );
	}

	public function test_missing_echo_on_the_repeat_is_cached() {
		$this->assertSame( 'cached', Naulon_File_Probe::classify( $this->env(), $this->ok_a(), $this->reply( 'b', 'b' ), $this->reply( 'c', null ) )['status'] );
	}

	public function test_header_value_shape() {
		$this->assertSame(
			'cached; types=json,pdf; at=1760000000',
			Naulon_File_Probe::header_for(
				array(
					'status' => 'cached',
					'types'  => array( 'json', 'pdf' ),
					'at'     => 1760000000,
					'detail' => 'x',
				)
			)
		);
		$this->assertSame( '', Naulon_File_Probe::header_for( null ) );
	}

	public function test_cache_name_from_headers() {
		$this->assertSame( 'Cloudflare (HIT)', Naulon_File_Probe::cache_name( array( 'cf-cache-status' => 'HIT' ) ) );
		$this->assertSame( 'LiteSpeed (hit)', Naulon_File_Probe::cache_name( array( 'x-litespeed-cache' => 'hit' ) ) );
		$this->assertSame( 'a cache (HIT from edge)', Naulon_File_Probe::cache_name( array( 'x-cache' => 'HIT from edge' ) ) );
		$this->assertSame( '', Naulon_File_Probe::cache_name( array() ) );
	}
}
