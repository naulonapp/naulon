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

	/** Molongui's guest-author post type. */
	const GUEST_POST_TYPE = 'guest_author';

	public function for_post( $post ) {
		$refs = get_post_meta( $post->ID, '_molongui_author', false );
		return array_values(
			array_filter(
				Naulon_Authors::from_molongui_refs( is_array( $refs ) ? $refs : array() ),
				array( $this, 'is_real_guest' )
			)
		);
	}

	/**
	 * A `guest-<id>` reference is only a post id, which an author can point at any post. Only a
	 * published Molongui guest profile counts: any other id (a private or draft post, a page) would
	 * print that post's title as a byline in the public catalog.
	 *
	 * @param array $entry A normalized entry.
	 * @return bool
	 */
	public function is_real_guest( $entry ) {
		if ( ! isset( $entry['guest_id'] ) ) {
			return true;
		}
		return self::GUEST_POST_TYPE === get_post_type( $entry['guest_id'] ) && 'publish' === get_post_status( $entry['guest_id'] );
	}
}
