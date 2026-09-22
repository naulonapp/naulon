<?php
/**
 * languages/naulon.pot is what translate.wordpress.org serves to every translator, and nothing
 * regenerates it automatically. It went two months and 61 strings stale without a single check
 * objecting: the shipped template said "naulon 0.5.0" while the plugin shipped 0.5.4, and
 * whole admin screens had no entry at all, so those screens could not be translated into any
 * language and no reader of the repository could tell.
 *
 * This asserts the property that matters rather than re-running WP-CLI: every literal string
 * the source hands to a translation function has a msgid in the template. Regenerate with
 *
 *     wp i18n make-pot . languages/naulon.pot --slug=naulon --domain=naulon --exclude=tests,bin,vendor
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class PotCompletenessTest extends TestCase {

	/** First argument is translatable; _n/_nx also translate the second. */
	private static $single = array( '__', '_e', 'esc_html__', 'esc_attr__', 'esc_html_e', 'esc_attr_e', '_x', '_ex', 'esc_html_x', 'esc_attr_x' );
	private static $plural = array( '_n', '_nx' );

	private function plugin_dir() {
		return dirname( dirname( __DIR__ ) );
	}

	/**
	 * Every translatable literal in the shipped source, as the text appears to a translator.
	 *
	 * @return array<string,string> string => "file:line" of its first occurrence.
	 */
	private function source_strings() {
		$found = array();
		$roots = array( $this->plugin_dir() . '/includes', $this->plugin_dir() . '/naulon.php', $this->plugin_dir() . '/uninstall.php' );

		$files = array();
		foreach ( $roots as $root ) {
			if ( is_file( $root ) ) {
				$files[] = $root;
				continue;
			}
			$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $root ) );
			foreach ( $it as $f ) {
				if ( 'php' === $f->getExtension() ) {
					$files[] = $f->getPathname();
				}
			}
		}

		foreach ( $files as $file ) {
			$tokens = token_get_all( file_get_contents( $file ) );
			$count  = count( $tokens );

			for ( $i = 0; $i < $count; $i++ ) {
				if ( ! is_array( $tokens[ $i ] ) || T_STRING !== $tokens[ $i ][0] ) {
					continue;
				}
				$fn = $tokens[ $i ][1];
				$n  = in_array( $fn, self::$plural, true ) ? 2 : ( in_array( $fn, self::$single, true ) ? 1 : 0 );
				if ( 0 === $n ) {
					continue;
				}
				// A method or property of the same name is not the i18n function.
				if ( isset( $tokens[ $i - 1 ] ) && is_array( $tokens[ $i - 1 ] ) && in_array( $tokens[ $i - 1 ][0], array( T_OBJECT_OPERATOR, T_DOUBLE_COLON, T_FUNCTION ), true ) ) {
					continue;
				}

				$literals = $this->leading_literals( $tokens, $i, $n );
				foreach ( $literals as $literal ) {
					if ( ! isset( $found[ $literal ] ) ) {
						$found[ $literal ] = basename( $file ) . ':' . $tokens[ $i ][2];
					}
				}
			}
		}

		return $found;
	}

	/**
	 * The first $want arguments of the call opening at $i, but only while they are plain string
	 * literals. A concatenated or variable argument is not extractable by WP-CLI either, so it
	 * is not something this test can or should demand of the template.
	 *
	 * @param array $tokens Token stream.
	 * @param int   $i      Index of the function-name token.
	 * @param int   $want   How many leading arguments are translatable.
	 * @return string[]
	 */
	private function leading_literals( array $tokens, $i, $want ) {
		$count = count( $tokens );
		$j     = $i + 1;
		while ( $j < $count && is_array( $tokens[ $j ] ) && T_WHITESPACE === $tokens[ $j ][0] ) {
			$j++;
		}
		if ( $j >= $count || '(' !== $tokens[ $j ] ) {
			return array();
		}

		$depth = 0;
		$arg   = 0;
		$out   = array();
		$solid = true;

		for ( ; $j < $count; $j++ ) {
			$text = is_array( $tokens[ $j ] ) ? $tokens[ $j ][1] : $tokens[ $j ];

			if ( '(' === $text || '[' === $text ) {
				$depth++;
				continue;
			}
			if ( ')' === $text || ']' === $text ) {
				$depth--;
				if ( 0 === $depth ) {
					break;
				}
				continue;
			}
			if ( ',' === $text && 1 === $depth ) {
				$arg++;
				$solid = true;
				if ( $arg >= $want ) {
					break;
				}
				continue;
			}
			if ( 1 !== $depth || ( is_array( $tokens[ $j ] ) && in_array( $tokens[ $j ][0], array( T_WHITESPACE, T_COMMENT, T_DOC_COMMENT ), true ) ) ) {
				continue;
			}
			if ( is_array( $tokens[ $j ] ) && T_CONSTANT_ENCAPSED_STRING === $tokens[ $j ][0] && $solid ) {
				$out[ $arg ] = $this->unquote( $tokens[ $j ][1] );
				$solid       = false; // a second token in this argument means it is built, not literal
				continue;
			}
			unset( $out[ $arg ] ); // concatenation, a constant, a variable: not a literal
			$solid = false;
		}

		return array_values( $out );
	}

	/**
	 * @param string $literal A PHP single- or double-quoted literal, with its quotes.
	 * @return string
	 */
	private function unquote( $literal ) {
		$quote = $literal[0];
		$body  = substr( $literal, 1, -1 );
		if ( "'" === $quote ) {
			return str_replace( array( "\\\\", "\\'" ), array( '\\', "'" ), $body );
		}
		return stripcslashes( $body );
	}

	/** @return string[] Every msgid and msgid_plural in the template. */
	private function template_strings() {
		$pot = file_get_contents( $this->plugin_dir() . '/languages/naulon.pot' );
		$this->assertNotFalse( $pot, 'languages/naulon.pot is missing' );

		$out     = array();
		$current = null;

		foreach ( explode( "\n", $pot ) as $line ) {
			$line = rtrim( $line, "\r" );
			if ( preg_match( '/^(msgid|msgid_plural)\s+"(.*)"$/', $line, $m ) ) {
				if ( null !== $current ) {
					$out[] = $current;
				}
				$current = stripcslashes( $m[2] );
				continue;
			}
			if ( null !== $current && preg_match( '/^"(.*)"$/', $line, $m ) ) {
				$current .= stripcslashes( $m[1] );
				continue;
			}
			if ( null !== $current ) {
				$out[] = $current;
				$current = null;
			}
		}
		if ( null !== $current ) {
			$out[] = $current;
		}

		return $out;
	}

	public function test_every_translatable_literal_has_a_template_entry() {
		$template = array_flip( $this->template_strings() );
		$missing  = array();

		foreach ( $this->source_strings() as $string => $where ) {
			if ( ! isset( $template[ $string ] ) ) {
				$missing[] = $where . '  ' . $string;
			}
		}

		$this->assertSame(
			array(),
			$missing,
			"languages/naulon.pot does not carry every translatable string. Regenerate it:\n"
			. "  wp i18n make-pot . languages/naulon.pot --slug=naulon --domain=naulon --exclude=tests,bin,vendor\n"
			. "Missing:\n  " . implode( "\n  ", $missing )
		);
	}

	/**
	 * The template also carries the plugin's own name and version, which a translator reads as
	 * the project they are working on. The 0.5.0 header on a 0.5.4 plugin is what made the
	 * staleness visible after the fact.
	 */
	public function test_the_template_names_the_shipping_version() {
		$version = array();
		preg_match( '/^\s*\*\s*Version:\s*(\S+)/m', file_get_contents( $this->plugin_dir() . '/naulon.php' ), $version );
		$pot = file_get_contents( $this->plugin_dir() . '/languages/naulon.pot' );

		$this->assertStringContainsString(
			' ' . $version[1] . '\n',
			$pot,
			'languages/naulon.pot names a different version than the plugin header — it was generated against older source'
		);
	}
}
