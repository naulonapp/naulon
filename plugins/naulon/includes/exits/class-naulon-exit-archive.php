<?php
/**
 * The archive door: many themes print whole posts on the home page, category, tag, author, date and
 * search pages. Those pages are not the article, so the article page's toll never sees them. For a
 * requester the toll would charge, each sold post on such a page shows its teaser and a link to the
 * article, where it is sold.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Exit_Archive implements Naulon_Content_Exit {

	/** @var Naulon_Exits */
	private $exits;

	public function id() {
		return 'wordpress-archive';
	}

	public function register( $exits ) {
		$this->exits = $exits;
		add_filter( 'the_content', array( $this, 'post' ), 999 );
		add_action( 'template_redirect', array( $this, 'headers' ), 3 );
	}

	/** @return bool Is this a listing page, not an article, a feed or the admin? */
	private static function is_listing() {
		return ! is_singular() && ! is_feed() && ! is_admin() && ! wp_doing_ajax() && ! ( defined( 'REST_REQUEST' ) && REST_REQUEST );
	}

	/**
	 * @param string $content The post's rendered body on a listing page.
	 * @return string
	 */
	public function post( $content ) {
		if ( ! self::is_listing() || ! in_the_loop() || ! is_main_query() ) {
			return $content;
		}
		$post = get_post();
		if ( ! $post instanceof WP_Post || ! $this->exits->sells( $post ) || ! $this->exits->charges_requester() ) {
			return $content;
		}
		return wpautop( esc_html( Naulon_Exits::teaser( $post ) ) )
			. sprintf( '<p><a href="%s">%s</a></p>', esc_url( get_permalink( $post ) ), esc_html__( 'Read the full article', 'naulon' ) );
	}

	/** @return void */
	public function headers() {
		if ( ! self::is_listing() ) {
			return;
		}
		$enforcer = Naulon_Enforcer::instance();
		$enforcer->vary_user_agent();
		if ( $this->exits->charges_requester() && ! headers_sent() ) {
			$enforcer->no_store();
		}
	}
}
