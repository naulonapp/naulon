<?php
/**
 * A route that hands out an article's text without going through its page.
 *
 * The toll charges an agent on the article page; WordPress also serves the same words through its
 * REST API, its feeds and its archive pages. Each exit closes one of those doors for a requester the
 * toll would charge, and leaves it open for everyone it serves free. Adding a door is one class,
 * registered in `Naulon_Exits::default_exits()`.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

interface Naulon_Content_Exit {

	/**
	 * Stable id, sent on a stripped response.
	 *
	 * @return string
	 */
	public function id();

	/**
	 * Hook the exit into WordPress.
	 *
	 * @param Naulon_Exits $exits The registry, which answers who is asking and which posts are sold.
	 * @return void
	 */
	public function register( $exits );
}
