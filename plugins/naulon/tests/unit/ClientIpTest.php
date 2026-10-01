<?php
/**
 * Which address the identity check reads. A header is believed only from a peer that could have
 * set it: Cloudflare's own header from a Cloudflare address, or the one header the publisher
 * configured for the proxy their host documents.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class ClientIpTest extends TestCase {

	private function ranges() {
		return array(
			'operators' => array(),
			'table'     => array(),
			'proxies'   => array( 'cloudflare' => Naulon_Ip::compile( array( '173.245.48.0/20' ) ) ),
		);
	}

	public function test_public_remote_addr_with_no_header() {
		$this->assertSame( '66.249.66.1', Naulon_Agent::client_ip( array( 'REMOTE_ADDR' => '66.249.66.1' ), '', $this->ranges() ) );
	}

	public function test_cloudflare_peer_hands_over_its_header() {
		$server = array(
			'REMOTE_ADDR'           => '173.245.48.5',
			'HTTP_CF_CONNECTING_IP' => '66.249.66.1',
		);
		$this->assertSame( '66.249.66.1', Naulon_Agent::client_ip( $server, '', $this->ranges() ) );
		$server['HTTP_CF_CONNECTING_IPV6'] = '2001:4860:4801:10::9';
		$this->assertSame( '2001:4860:4801:10::9', Naulon_Agent::client_ip( $server, '', $this->ranges() ) );
	}

	/** The spoof case: anyone can send CF-Connecting-IP straight to the origin. */
	public function test_cloudflare_header_from_a_non_cloudflare_peer_is_ignored() {
		$server = array(
			'REMOTE_ADDR'           => '9.9.9.9',
			'HTTP_CF_CONNECTING_IP' => '66.249.66.1',
		);
		$this->assertSame( '9.9.9.9', Naulon_Agent::client_ip( $server, '', $this->ranges() ) );
	}

	public function test_configured_header_returns_its_first_entry() {
		$server = array(
			'REMOTE_ADDR'            => '10.0.0.5',
			'HTTP_X_SUCURI_CLIENTIP' => ' 66.249.66.1 , 10.0.0.9',
		);
		$this->assertSame( '66.249.66.1', Naulon_Agent::client_ip( $server, 'HTTP_X_SUCURI_CLIENTIP', $this->ranges() ) );
	}

	/** Same as the gate's callerIp: a configured header that is absent yields no address. */
	public function test_configured_header_missing_yields_null() {
		$this->assertNull( Naulon_Agent::client_ip( array( 'REMOTE_ADDR' => '66.249.66.1' ), 'HTTP_X_SUCURI_CLIENTIP', $this->ranges() ) );
	}

	/** Review focus: a load balancer in front, nothing configured. The check reads it as unverified. */
	public function test_private_lb_address_is_returned_and_never_verifies() {
		$ip = Naulon_Agent::client_ip( array( 'REMOTE_ADDR' => '10.0.0.5' ), '', $this->ranges() );
		$this->assertSame( '10.0.0.5', $ip );
		$this->assertSame( 'unverified', Naulon_Identity::check( 'Googlebot/2.1', null, $ip, 0 )['check'] );
	}

	public function test_without_ranges_cloudflare_cannot_be_recognised() {
		$server = array(
			'REMOTE_ADDR'           => '173.245.48.5',
			'HTTP_CF_CONNECTING_IP' => '66.249.66.1',
		);
		$this->assertSame( '173.245.48.5', Naulon_Agent::client_ip( $server, '', null ) );
	}

	public function test_no_remote_addr() {
		$this->assertNull( Naulon_Agent::client_ip( array(), '', null ) );
	}

	public function test_header_setting_sanitizer() {
		$this->assertSame( 'HTTP_X_SUCURI_CLIENTIP', Naulon_Settings::sanitize_ip_header( 'X-Sucuri-ClientIP' ) );
		$this->assertSame( 'HTTP_X_SUCURI_CLIENTIP', Naulon_Settings::sanitize_ip_header( 'HTTP_X_SUCURI_CLIENTIP' ) );
		$this->assertSame( '', Naulon_Settings::sanitize_ip_header( '' ) );
		$this->assertSame( '', Naulon_Settings::sanitize_ip_header( 'X-Bad Header' ) );
		$this->assertSame( '', Naulon_Settings::sanitize_ip_header( 'X-Real-IP; drop' ) );
	}

	/** Their first entry is whatever the client sent, so trusting one lets a forger verify itself. */
	public function test_client_appendable_headers_are_refused_as_trusted() {
		foreach ( array( 'X-Forwarded-For', 'HTTP_X_FORWARDED_FOR', 'Forwarded', 'x-forwarded-for' ) as $h ) {
			$this->assertSame( '', Naulon_Settings::sanitize_ip_header( $h ), $h );
		}
	}

	/** The gate's callerIp: a configured cf-connecting-ip prefers CF-Connecting-IPv6 when sent. */
	public function test_configured_cloudflare_header_prefers_the_ipv6_one() {
		$server = array(
			'REMOTE_ADDR'             => '10.0.0.5',
			'HTTP_CF_CONNECTING_IP'   => '240.1.2.3',
			'HTTP_CF_CONNECTING_IPV6' => '2001:4860:4801:10::9',
		);
		$this->assertSame( '2001:4860:4801:10::9', Naulon_Agent::client_ip( $server, 'HTTP_CF_CONNECTING_IP', null ) );
		unset( $server['HTTP_CF_CONNECTING_IPV6'] );
		$this->assertSame( '240.1.2.3', Naulon_Agent::client_ip( $server, 'HTTP_CF_CONNECTING_IP', null ) );
	}

	/**
	 * WordPress adds slashes to $_SERVER (wp_magic_quotes), so a quoted address arrives as \"...\".
	 * Read slashed, it parses to nothing and a real crawler behind a quoting proxy never verifies.
	 */
	public function test_wordpress_slashes_are_removed_before_the_address_is_read() {
		$server = array(
			'REMOTE_ADDR'          => '10.0.0.5',
			'HTTP_X_TEST_CLIENT_IP' => '\\"[2001:4860:4801:10::9]:443\\"',
		);
		$ip = Naulon_Agent::client_ip( $server, 'HTTP_X_TEST_CLIENT_IP', null );
		$this->assertNotNull( Naulon_Ip::parse_client_address( $ip ) );
	}
}
