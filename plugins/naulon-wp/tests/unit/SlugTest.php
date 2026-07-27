<?php
/**
 * Slug canonicalization — the tests that encode the production incident.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class SlugTest extends TestCase {

	public function test_strips_leading_slash_to_match_how_the_gate_derives_a_slug() {
		$this->assertSame( 'blog/my-post', Naulon_Slug::canonicalize( '/blog/my-post' ) );
		$this->assertSame( 'blog/my-post', Naulon_Slug::canonicalize( '/blog/my-post/' ) );
		$this->assertSame( 'my-post', Naulon_Slug::canonicalize( 'my-post' ) );
	}

	public function test_reduces_a_full_url_to_its_path() {
		$this->assertSame( 'blog/my-post', Naulon_Slug::canonicalize( 'https://example.com/blog/my-post/' ) );
		$this->assertSame( 'blog/my-post', Naulon_Slug::canonicalize( 'https://example.com/blog/my-post?utm=x' ) );
		$this->assertSame( 'blog/my-post', Naulon_Slug::canonicalize( 'https://example.com/blog/my-post#top' ) );
	}

	public function test_lowercases_and_decodes_once() {
		$this->assertSame( 'blog/my post', Naulon_Slug::canonicalize( '/Blog/my%20post' ) );
		// One decode pass only: a doubly-encoded traversal must not become a traversal.
		$this->assertSame( '%2e%2e/secret', Naulon_Slug::canonicalize( '/%252e%252e/secret' ) );
	}

	public function test_empty_and_junk_inputs_collapse_to_empty() {
		$this->assertSame( '', Naulon_Slug::canonicalize( '' ) );
		$this->assertSame( '', Naulon_Slug::canonicalize( '   ' ) );
		$this->assertSame( '', Naulon_Slug::canonicalize( '/' ) );
		$this->assertSame( '', Naulon_Slug::canonicalize( null ) );
		$this->assertSame( '', Naulon_Slug::canonicalize( array( 'x' ) ) );
	}

	public function test_leaf_is_the_last_segment() {
		$this->assertSame( 'my-post', Naulon_Slug::leaf( '/blog/2026/my-post/' ) );
		$this->assertSame( 'my-post', Naulon_Slug::leaf( 'my-post' ) );
		$this->assertSame( '', Naulon_Slug::leaf( '/' ) );
	}

	public function test_is_leaf_flags_the_ambiguous_shape() {
		$this->assertTrue( Naulon_Slug::is_leaf( 'my-post' ) );
		$this->assertFalse( Naulon_Slug::is_leaf( 'blog/my-post' ) );
		$this->assertFalse( Naulon_Slug::is_leaf( '' ) );
	}

	public function test_prefixes_are_derived_from_the_permalink_structure_not_hand_entered() {
		$this->assertSame( array( 'blog/' ), Naulon_Slug::prefixes_from_structure( '/blog/%postname%/' ) );
		$this->assertSame( array( 'news/archive/' ), Naulon_Slug::prefixes_from_structure( '/news/archive/%postname%/' ) );
	}

	public function test_a_structure_with_no_static_prefix_yields_none() {
		$this->assertSame( array(), Naulon_Slug::prefixes_from_structure( '/%postname%/' ) );
		$this->assertSame( array(), Naulon_Slug::prefixes_from_structure( '/%year%/%monthnum%/%postname%/' ) );
		$this->assertSame( array(), Naulon_Slug::prefixes_from_structure( '' ) );
		$this->assertSame( array(), Naulon_Slug::prefixes_from_structure( null ) );
	}
}
