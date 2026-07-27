<?php
/**
 * The default control-plane address, pinned.
 *
 * This is a one-line constant with a disproportionate failure mode. `api.naulon.app` is the
 * Supabase/Kong edge, and it answers `/_naulon/*` with its own `401 Unauthorized` — which is
 * indistinguishable from "your key was rejected" unless someone thinks to read the
 * `x-kong-request-id` header. A plugin shipped with that address would tell every publisher
 * their key was bad, forever, while the key was fine.
 *
 * It was shipped with that address, caught by curling both hosts against production, and the
 * identical trap had already been found and documented for the agent connect snippets a week
 * earlier. Twice is a pattern, so it gets a test.
 *
 * @package naulon
 */

class ControlPlaneAddressTest extends PHPUnit\Framework\TestCase {

	public function test_the_default_is_the_gate_host_and_never_the_supabase_edge() {
		$this->assertSame( 'https://gate.naulon.app', Naulon_Settings::DEFAULT_API_BASE );
		$this->assertStringNotContainsString( 'api.naulon.app', Naulon_Settings::DEFAULT_API_BASE );
	}

	public function test_the_default_has_no_trailing_slash() {
		// Every path in the client begins with '/', so a trailing slash here produces '//_naulon'
		// — which some proxies normalize and some do not.
		$this->assertSame( rtrim( Naulon_Settings::DEFAULT_API_BASE, '/' ), Naulon_Settings::DEFAULT_API_BASE );
	}

	public function test_the_default_is_https() {
		// The key travels on this connection.
		$this->assertStringStartsWith( 'https://', Naulon_Settings::DEFAULT_API_BASE );
	}
}
