<?php
/**
 * The feed door: WordPress feeds carry each post's full text by default (`content:encoded` in RSS,
 * `<content>` in Atom). For a requester the toll would charge, a sold post's feed body becomes its
 * teaser, item by item, so a post the site gives away keeps its full text. The summary stays: it is
 * what a feed exists to publish.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Exit_Feed implements Naulon_Content_Exit {

	/** @var Naulon_Exits */
	private $exits;

	public function id() {
		return 'wordpress-feed';
	}

	public function register( $exits ) {
		$this->exits = $exits;
		add_filter( 'the_content_feed', array( $this, 'item' ), 999 );
		add_action( 'template_redirect', array( $this, 'headers' ), 3 );
	}

	/**
	 * @param string $content The item's feed body.
	 * @return string
	 */
	public function item( $content ) {
		$post = get_post();
		if ( ! $post instanceof WP_Post || ! $this->exits->sells( $post ) || ! $this->exits->charges_requester() ) {
			return $content;
		}
		return wpautop( esc_html( Naulon_Exits::teaser( $post ) ) );
	}

	/** @return void */
	public function headers() {
		if ( ! is_feed() ) {
			return;
		}
		$enforcer = Naulon_Enforcer::instance();
		$enforcer->vary_user_agent();
		if ( $this->exits->charges_requester() && ! headers_sent() ) {
			$enforcer->no_store();
			header( Naulon_Exits::HEADER . ': ' . $this->id() );
		}
	}
}
