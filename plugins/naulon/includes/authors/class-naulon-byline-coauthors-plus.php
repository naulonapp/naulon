<?php
/**
 * Co-Authors Plus: `get_coauthors()` returns WP_User objects and guest objects
 * (`type` "guest-author", `ID` = the guest profile's post id, `wp_user` when linked to an account).
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Byline_Coauthors_Plus implements Naulon_Byline_Source {

	public function id() {
		return 'co-authors-plus';
	}

	public function is_active() {
		return class_exists( 'CoAuthors_Plus' ) && function_exists( 'get_coauthors' );
	}

	public function for_post( $post ) {
		return Naulon_Authors::from_objects( get_coauthors( $post->ID ) );
	}
}
