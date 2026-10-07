<?php
/**
 * Molongui Authorship: repeated `_molongui_author` post meta, each `user-<id>` or `guest-<id>`
 * (a guest is a post of Molongui's guest-author type, so its title is its name).
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Byline_Molongui implements Naulon_Byline_Source {

	public function id() {
		return 'molongui-authorship';
	}

	public function is_active() {
		// Its main class is namespaced, so a bare `class_exists` never matches; the constant it
		// defines on load is the marker.
		return defined( 'MOLONGUI_AUTHORSHIP_VERSION' );
	}

	public function for_post( $post ) {
		$refs = get_post_meta( $post->ID, '_molongui_author', false );
		return Naulon_Authors::from_molongui_refs( is_array( $refs ) ? $refs : array() );
	}
}
