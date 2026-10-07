<?php
/**
 * The content exits, and the two questions each one asks: is this requester someone the toll would
 * charge (`Naulon_Enforcer::charges_requester`, the article page's own rules), and is this post one
 * the toll sells (`Naulon_Credits`). Answers are local; no exit calls the control plane.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Exits {

	/** Response header naming the exit that stripped a body. */
	const HEADER = 'X-Naulon-Exit';

	/** @var Naulon_Exits|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * @return Naulon_Content_Exit[]
	 */
	public static function default_exits() {
		return array( new Naulon_Exit_Rest(), new Naulon_Exit_Feed(), new Naulon_Exit_Archive() );
	}

	public function register() {
		/**
		 * Filter the content exits. Anything that does not implement the interface is ignored.
		 *
		 * @param Naulon_Content_Exit[] $exits The default exits.
		 */
		$exits = apply_filters( 'naulon_content_exits', self::default_exits() );
		foreach ( is_array( $exits ) ? $exits : array() as $exit ) {
			if ( $exit instanceof Naulon_Content_Exit ) {
				$exit->register( $this );
			}
		}
	}

	/**
	 * Would the toll charge whoever is asking?
	 *
	 * @return bool
	 */
	public function charges_requester() {
		return Naulon_Enforcer::instance()->charges_requester();
	}

	/**
	 * Is this post sold: tollable and crediting someone, exactly as the credits endpoint decides.
	 *
	 * @param WP_Post $post The post.
	 * @return bool
	 */
	public function sells( $post ) {
		$credits = Naulon_Credits::instance();
		return $post instanceof WP_Post
			&& in_array( $post->post_type, $credits->tollable_post_types(), true )
			&& $credits->is_tollable( $post )
			&& ! empty( $credits->contributors_for( $post ) );
	}

	/**
	 * The teaser a stripped exit serves in place of a body: the post's own excerpt, else the opening
	 * words WordPress itself would publish as one. Built without `the_content`, so an exit filtering
	 * that hook cannot recurse into itself.
	 *
	 * @param WP_Post $post The post.
	 * @return string Plain text.
	 */
	public static function teaser( $post ) {
		$text = '' !== trim( (string) $post->post_excerpt ) ? $post->post_excerpt : strip_shortcodes( (string) $post->post_content );
		return wp_trim_words( wp_strip_all_tags( $text ), 55 );
	}
}
