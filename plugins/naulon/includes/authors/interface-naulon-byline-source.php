<?php
/**
 * One way a site records who wrote a post.
 *
 * WordPress stores one author per post; multi-author plugins each store bylines their own way. Each
 * source reads one of them and returns normalized entries, so the credits and catalog endpoints never
 * know which plugin a site runs. Adding support for another plugin is one class implementing this,
 * registered in `Naulon_Authors::default_sources()`.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

interface Naulon_Byline_Source {

	/**
	 * A stable id for the source, used in diagnostics.
	 *
	 * @return string
	 */
	public function id();

	/**
	 * Is the plugin this source reads installed and active? Checked by a marker that only that
	 * plugin defines, never by a function another plugin may shim.
	 *
	 * @return bool
	 */
	public function is_active();

	/**
	 * The post's authors in byline order, or an empty array when this source has none for it.
	 *
	 * @param WP_Post $post The post.
	 * @return array[] Each {user_id, name?} or {guest_id, name?}; see `Naulon_Authors`.
	 */
	public function for_post( $post );
}
