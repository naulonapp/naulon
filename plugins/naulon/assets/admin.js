/**
 * Copy buttons on naulon's admin screens. A button with data-naulon-copy="<id>" copies that
 * textarea. Where the browser refuses the clipboard, the text is selected so Ctrl+C still works.
 */
( function () {
	document.addEventListener( 'click', function ( event ) {
		var button = event.target.closest ? event.target.closest( '[data-naulon-copy]' ) : null;
		if ( ! button ) {
			return;
		}
		var field = document.getElementById( button.getAttribute( 'data-naulon-copy' ) );
		if ( ! field ) {
			return;
		}
		var done = function () {
			var label = button.textContent;
			button.textContent = button.getAttribute( 'data-naulon-copied' ) || label;
			setTimeout( function () {
				button.textContent = label;
			}, 2000 );
		};
		var select = function () {
			field.focus();
			field.select();
		};
		if ( navigator.clipboard && navigator.clipboard.writeText ) {
			navigator.clipboard.writeText( field.value ).then( done, select );
		} else {
			select();
		}
	} );
}() );
