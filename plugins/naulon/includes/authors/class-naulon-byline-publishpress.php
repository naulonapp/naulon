<?php
/**
 * PublishPress Authors: `get_post_authors()` returns Author objects whose `ID` is the user id, or the
 * NEGATED term id for a guest author. It also defines `get_coauthors()` for compatibility, which is
 * why activity is read off `publishpress_authors_get_post_authors`, a function only it defines.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Byline_PublishPress implements Naulon_Byline_Source {

	public function id() {
		return 'publishpress-authors';
	}

	public function is_active() {
		return function_exists( 'publishpress_authors_get_post_authors' ) && function_exists( 'get_post_authors' );
	}

	public function for_post( $post ) {
		return Naulon_Authors::from_objects( get_post_authors( $post->ID ) );
	}
}
