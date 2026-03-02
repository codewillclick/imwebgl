
# Purpose

HTML-injectible javascript library to be src-ed from websites or webtools, which will allow an invisible webgl overlay to render over existing images on the screen in an efficient and achievable manner.

For example, a webtoon comics reader with many over-tall images arranged vertically, the view as the user scrolls down will have a webgl canvas rendering over the images, so that custom filters and color levels can be applied.

Now, the color levels thing is a separate project, but you get the idea.

We're allowing webgl to draw over actual images on a webpage, applying wahtever shader filters are needed.


# Docs

There are a number of doc.\*.md files in the root project directory.  These are meant as specfiications for the individual components of the tool.


# Clarifications

I'll put clarifications here that I haven't sorted out to be reflected in their respective doc files.

The ouptut format of this project is a js file that can be "\<script src=imwebgl.js>"-ed.

Let's not worry about CORS for the moment, since at least for starters, this will likely be rendered in-place into the index.html with a string replacement, anyway.  Wait did I actually answer the CORS question, or shift into describing something else?  Don't worry about modern modules, rather, since this is meant at the beginning to be inserted as plaintext.

WebGL2?  The heck?  When did this happen?  Jeez, I suddenly feel old.  Alright use WebGL2 over WebGL.

A web-worker, huh...  Go ahead and use the web-worker method.

