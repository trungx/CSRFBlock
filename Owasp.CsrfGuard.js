/**
 * The OWASP CSRFGuard Project, BSD License
 * Eric Sheridan (eric.sheridan@owasp.org), Copyright (c) 2011 
 * All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 *    1. Redistributions of source code must retain the above copyright notice,
 *       this list of conditions and the following disclaimer.
 *    2. Redistributions in binary form must reproduce the above copyright
 *       notice, this list of conditions and the following disclaimer in the
 *       documentation and/or other materials provided with the distribution.
 *    3. Neither the name of OWASP nor the names of its contributors may be used
 *       to endorse or promote products derived from this software without specific
 *       prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var csrfblock_executed = false;
var csrfblock = function(directExecution) {
  
	/** string utility functions * */
	String.prototype.startsWith = function(prefix) {
		return this.indexOf(prefix) === 0;
	}

	String.prototype.endsWith = function(suffix) {
		return this.match(suffix+"$") == suffix;
	};

	/** hook using standards based prototype * */
	function hijackStandard() {
		XMLHttpRequest.prototype._open = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {
			this.url = url;
			
			this._open.apply(this, arguments);
		}
		
		XMLHttpRequest.prototype._send = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.send = function(data) {
			if(this.onsend != null) {
				this.onsend.apply(this, arguments);
			}
			
			this._send.apply(this, arguments);
		}
	}

	/** ie does not properly support prototype - wrap completely * */
	function hijackExplorer() {
		var _XMLHttpRequest = window.XMLHttpRequest;
		
		function alloc_XMLHttpRequest() {
			this.base = _XMLHttpRequest ? new _XMLHttpRequest : new window.ActiveXObject("Microsoft.XMLHTTP");
		}
		
		function init_XMLHttpRequest() {
			return new alloc_XMLHttpRequest;
		}
		
		init_XMLHttpRequest.prototype = alloc_XMLHttpRequest.prototype;
		
		/** constants * */
		init_XMLHttpRequest.UNSENT = 0;
		init_XMLHttpRequest.OPENED = 1;
		init_XMLHttpRequest.HEADERS_RECEIVED = 2;
		init_XMLHttpRequest.LOADING = 3;
		init_XMLHttpRequest.DONE = 4;
		
		/** properties * */
		init_XMLHttpRequest.prototype.status = 0;
		init_XMLHttpRequest.prototype.statusText = "";
		init_XMLHttpRequest.prototype.readyState = init_XMLHttpRequest.UNSENT;
		init_XMLHttpRequest.prototype.responseText = "";
		init_XMLHttpRequest.prototype.responseXML = null;
		init_XMLHttpRequest.prototype.onsend = null;
		
		init_XMLHttpRequest.url = null;
		init_XMLHttpRequest.onreadystatechange = null;

		/** methods * */
		init_XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {
			var self = this;
			this.url = url;
			
			this.base.open(method, url, async, user, pass);
			
			this.base.onreadystatechange = function() {
				try { self.status = self.base.status; } catch (e) { }
				try { self.statusText = self.base.statusText; } catch (e) { }
				try { self.readyState = self.base.readyState; } catch (e) { }
				try { self.responseText = self.base.responseText; } catch(e) { }
				try { self.responseXML = self.base.responseXML; } catch(e) { }
				
				if(self.onreadystatechange != null) {
					self.onreadystatechange.apply(this, arguments);
				}
			}
		}
		
		init_XMLHttpRequest.prototype.send = function(data) {
			if(this.onsend != null) {
				this.onsend.apply(this, arguments);
			}
			
			this.base.send(data);
		}
		
		init_XMLHttpRequest.prototype.abort = function() {
			this.base.abort();
		}
		
		init_XMLHttpRequest.prototype.getAllResponseHeaders = function() {
			return this.base.getAllResponseHeaders();
		}
		
		init_XMLHttpRequest.prototype.getResponseHeader = function(name) {
			return this.base.getResponseHeader(name);
		}
		
		init_XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
			return this.base.setRequestHeader(name, value);
		}
		
		/** hook * */
		window.XMLHttpRequest = init_XMLHttpRequest;
	}

	/** check if valid domain based on domainStrict * */
	function isValidDomain(current, target) {
		var result = false;
		
		/** check exact or subdomain match * */
		if(current == target) {
			result = true;
		} else if(%DOMAIN_STRICT% == false) {
			if(target.charAt(0) == '.') {
				result = current.endsWith(target);
			} else {
				result = current.endsWith('.' + target);
			}
		}
		
		return result;
	}

	/** determine if uri/url points to valid domain * */
	function isValidUrl(src) {
		var result = false;
		
		/** parse out domain to make sure it points to our own * */
		if(src.substring(0, 7) == "http://" || src.substring(0, 8) == "https://") {
			var token = "://";
			var index = src.indexOf(token);
			var part = src.substring(index + token.length);
			var domain = "";
			
			/** parse up to end, first slash, or anchor * */
			for(i=0; i<part.length; i++) {
				var character = part.charAt(i);
				
				if(character == '/' || character == ':' || character == '#') {
					break;
				} else {
					domain += character;
				}
			}
			
			result = isValidDomain(document.domain, domain);
			/** explicitly skip anchors * */
		} else if(src.charAt(0) == '#') {
			result = false;
			/** ensure it is a local resource without a protocol * */
		} else if(!src.startsWith("//") && (src.charAt(0) == '/' || src.indexOf(':') == -1)) {
			result = true;
		}
		
		return result;
	}

	/** parse uri from url * */
	function parseUri(url) {
		var uri = "";
		var token = "://";
		var index = url.indexOf(token);
		var part = "";
		
		/**
		 * ensure to skip protocol and prepend context path for non-qualified
		 * resources (ex: "protect.html" vs
		 * "/Owasp.CsrfGuard.Test/protect.html").
		 */
		if(index > 0) {
			part = url.substring(index + token.length);
		} else if(url.charAt(0) != '/') {
			part = "%CONTEXT_PATH%/" + url;
		} else {
			part = url;
		}
		
		/** parse up to end or query string * */
		var uriContext = (index == -1);
		
		for(var i=0; i<part.length; i++) {
			var character = part.charAt(i);
			
			if(character == '/') {
				uriContext = true;
			} else if(uriContext == true && (character == '?' || character == '#')) {
				uriContext = false;
				break;
			}
			
			if(uriContext == true) {
				uri += character;
			}
		}
		
		return uri;
	}

	/** inject tokens as hidden fields into forms * */
	function injectTokenForm(form, tokenName, tokenValue) {
		var action = form.getAttribute("action");
		
		if(action != null && isValidUrl(action)) {
			var uri = parseUri(action);
			var hidden = document.createElement("input");
			
			hidden.setAttribute("type", "hidden");
			hidden.setAttribute("name", tokenName);
			hidden.setAttribute("value", tokenValue);
			
			form.appendChild(hidden);
		}
	}

	/** inject tokens as query string parameters into url * */
	function injectTokenAttribute(element, attr, tokenName, tokenValue) {
		var location = element.getAttribute(attr);
		
		if(location != null && isValidUrl(location)) {
			var uri = parseUri(location);
			
			if(location.indexOf('?') != -1) {
				location = location + '&' + tokenName + '=' + tokenValue;
			} else {
				location = location + '?' + tokenName + '=' + tokenValue;
			}

			try {
				element.setAttribute(attr, location);
			} catch (e) {
				// attempted to set/update unsupported attribute
			}
		}
	}

	/** inject csrf prevention tokens throughout dom * */
	function injectTokens(tokenList, tokenName, tokenValue, pageTokens) {
		/** iterate over all elements and injection token * */
		var all = document.all ? document.all : document.getElementsByTagName('*');
		var len = all.length;

		for(var i=0; i<len; i++) {
			var element = all[i];
			
			/** inject into form * */
			if(element.tagName.toLowerCase() == "form") {
				if(%INJECT_FORMS% == true) {
					var randToken = tokenList[Math.floor(Math.random()*tokenList.length)];
					injectTokenForm(element, randToken.name, randToken.value, tokenList);
				}
				/** inject into attribute * */
			} else if(%INJECT_ATTRIBUTES% == true) {
				var randToken = tokenList[Math.floor(Math.random()*tokenList.length)];
				injectTokenAttribute(element, "src", randToken.name, randToken.value);
				injectTokenAttribute(element, "href", randToken.name, randToken.value);
			}
		}
	}

	/** obtain array of page specific tokens * */
	function requestTokens(nb) {
		
		var xhr = new XMLHttpRequest();
		var pageTokens = {};
		var tokens = {};
		
		xhr.open("POST", "%SERVLET_PATH%", false);
		var params = "requestTokens="+nb;
		xhr.setRequestHeader("Content-type", "application/x-www-form-urlencoded");
		xhr.send(params);
		
		return JSON.parse(xhr.responseText);
	}

	/** utility method to register window.onload * */
	function addLoadEvent(func) {
		var oldonload = window.onload;
		
		if (typeof window.onload != "function") {
			window.onload = func;
		} else {
			window.onload = function() {
				oldonload();
				func();
			}
		}
	}

	/**
	 * Only inject the tokens if the JavaScript was referenced from HTML that
	 * was served by us. Otherwise, the code was referenced from malicious HTML
	 * which may be trying to steal tokens using JavaScript hijacking
	 * techniques.
	 */
	/** optionally include Ajax support * */
	if(%INJECT_XHR% == true && !csrfblock_executed) {
		if(navigator.appName == "Microsoft Internet Explorer") {
			hijackExplorer();
		} else {
			hijackStandard();
		}
		
		XMLHttpRequest.prototype.onsend = function(data) {
			if(isValidUrl(this.url) && this.url!="%SERVLET_PATH%") {
				var tokenList = requestTokens(1);
				this.setRequestHeader("X-Requested-With", "%X_REQUESTED_WITH%");
				this.setRequestHeader(tokenList[0].name, tokenList[0].value);
			}
		};
		
		csrfblock_executed = true;
	}
	
	if(!directExecution) {
		/** update nodes in DOM after load * */
		addLoadEvent(function() {
			injectTokens(requestTokens(10));
		});
	} else {
		injectTokens(requestTokens(10));
	}
	
	
	
};

csrfblock();
