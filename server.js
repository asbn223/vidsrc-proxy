// proxy/vidsrc-proxy.js
// Deploy to Cloudflare Workers or Node.js server

const BASE_URL = 'https://v2.vidsrc.me';
const ALTERNATIVE_API = 'https://2embed.stream';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Endpoint: /extract?tmdbId=123&type=movie
      if (path === '/extract') {
        const tmdbId = url.searchParams.get('tmdbId');
        const type = url.searchParams.get('type'); // 'movie' or 'tv'
        const season = url.searchParams.get('season');
        const episode = url.searchParams.get('episode');
        
        if (!tmdbId || !type) {
          return jsonResponse({ error: 'Missing required parameters' }, 400, corsHeaders);
        }
        
        const streams = await extractStreams(tmdbId, type, season, episode);
        return jsonResponse(streams, 200, corsHeaders);
      }
      
      // Endpoint: /proxy-stream?url=encoded_m3u8_url
      if (path === '/proxy-stream') {
        const targetUrl = decodeURIComponent(url.searchParams.get('url') || '');
        if (!targetUrl) {
          return jsonResponse({ error: 'Missing URL parameter' }, 400, corsHeaders);
        }
        
        return proxyStream(targetUrl, request.headers.get('User-Agent'), corsHeaders);
      }
      
      // Health check
      if (path === '/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() }, 200, corsHeaders);
      }
      
      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
      
    } catch (error) {
      console.error('Proxy error:', error);
      return jsonResponse({ 
        error: 'Internal server error',
        message: error.message 
      }, 500, corsHeaders);
    }
  }
};

async function extractStreams(tmdbId, type, season, episode) {
  // Strategy 1: Try 2embed.stream API (no captcha, direct M3U8)
  try {
    const embedUrl = type === 'movie' 
      ? `${ALTERNATIVE_API}/embed/${tmdbId}`
      : `${ALTERNATIVE_API}/embed/${tmdbId}/${season}/${episode}`;
    
    // Fetch the embed page
    const response = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://2embed.stream/',
      },
    });
    
    const html = await response.text();
    
    // Extract M3U8 URLs using regex patterns
    const streams = parseStreamsFromHtml(html, tmdbId, type, season, episode);
    
    if (streams.length > 0) {
      return {
        success: true,
        source: '2embed',
        tmdbId,
        type,
        season,
        episode,
        streams: streams.map(s => ({
          ...s,
          // Create proxied URL to bypass CORS/referer restrictions
          proxiedUrl: `/proxy-stream?url=${encodeURIComponent(s.url)}`
        })),
        timestamp: new Date().toISOString(),
      };
    }
  } catch (error) {
    console.error('2embed extraction failed:', error);
  }
  
  // Strategy 2: Try VidSrc directly (iframe extraction)
  try {
    const streams = await extractFromVidSrc(tmdbId, type, season, episode);
    if (streams.length > 0) {
      return {
        success: true,
        source: 'vidsrc',
        tmdbId,
        type,
        season,
        episode,
        streams,
        timestamp: new Date().toISOString(),
      };
    }
  } catch (error) {
    console.error('VidSrc extraction failed:', error);
  }
  
  return {
    success: false,
    error: 'No streams found',
    tmdbId,
    type,
  };
}

function parseStreamsFromHtml(html, tmdbId, type, season, episode) {
  const streams = [];
  
  // Pattern 1: Direct M3U8 URLs in JavaScript
  const m3u8Regex = /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/g;
  const m3u8Matches = [...html.matchAll(m3u8Regex)];
  
  // Pattern 2: JSON-encoded sources
  const sourcesRegex = /sources:\s*(\[[^\]]+\])/i;
  const sourcesMatch = html.match(sourcesRegex);
  
  // Pattern 3: Data attributes
  const dataRegex = /data-url="([^"]+)"/g;
  const dataMatches = [...html.matchAll(dataRegex)];
  
  // Process M3U8 URLs
  m3u8Matches.forEach((match, index) => {
    const url = match[1];
    // Determine quality from URL or default to auto
    const quality = extractQualityFromUrl(url) || (index === 0 ? 'auto' : `variant-${index}`);
    
    streams.push({
      url: url,
      quality: quality,
      type: 'hls',
      label: quality === 'auto' ? 'Auto' : quality,
    });
  });
  
  // Process JSON sources if found
  if (sourcesMatch) {
    try {
      const sources = JSON.parse(sourcesMatch[1]);
      sources.forEach(source => {
        if (source.file && !streams.find(s => s.url === source.file)) {
          streams.push({
            url: source.file,
            quality: source.label || extractQualityFromUrl(source.file) || 'auto',
            type: source.type || 'hls',
            label: source.label || 'Auto',
          });
        }
      });
    } catch (e) {
      console.error('Failed to parse sources JSON:', e);
    }
  }
  
  return streams;
}

function extractQualityFromUrl(url) {
  const patterns = [
    /(\d{3,4})p/i,
    /_(\d{3,4})_/,
    /\/(\d{3,4})\//,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return `${match[1]}p`;
    }
  }
  
  if (url.includes('master')) return 'auto';
  if (url.includes('1080')) return '1080p';
  if (url.includes('720')) return '720p';
  if (url.includes('480')) return '480p';
  
  return null;
}

async function extractFromVidSrc(tmdbId, type, season, episode) {
  // VidSrc requires more complex extraction - often needs puppeteer or similar
  // This is a simplified version that attempts direct API access
  
  const streams = [];
  
  // Try the .me API endpoints
  const endpoints = [
    type === 'movie' 
      ? `https://v2.vidsrc.me/embed/${tmdbId}`
      : `https://v2.vidsrc.me/embed/${tmdbId}/${season}-${episode}`,
  ];
  
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://v2.vidsrc.me/',
        },
      });
      
      const html = await response.text();
      const extracted = parseStreamsFromHtml(html, tmdbId, type, season, episode);
      streams.push(...extracted);
    } catch (error) {
      console.error(`Failed to extract from ${endpoint}:`, error);
    }
  }
  
  return streams;
}

async function proxyStream(targetUrl, userAgent, corsHeaders) {
  // Proxy the M3U8 or TS segments to handle CORS and referer restrictions
  
  const headers = {
    'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://2embed.stream/',
    'Origin': 'https://2embed.stream',
  };
  
  try {
    const response = await fetch(targetUrl, { headers });
    
    // If it's an M3U8 file, rewrite URLs to point to our proxy
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('application/vnd.apple.mpegurl') || 
        contentType.includes('application/x-mpegURL') ||
        targetUrl.endsWith('.m3u8')) {
      
      let body = await response.text();
      
      // Rewrite relative URLs to absolute and proxy them
      body = rewriteM3u8Urls(body, targetUrl);
      
      return new Response(body, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=60',
        },
      });
    }
    
    // For video segments, just proxy through
    return new Response(response.body, {
      status: response.status,
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
    
  } catch (error) {
    return jsonResponse({ error: 'Failed to proxy stream' }, 502, corsHeaders);
  }
}

function rewriteM3u8Urls(m3u8Content, baseUrl) {
  const baseUrlObj = new URL(baseUrl);
  const basePath = baseUrlObj.href.substring(0, baseUrlObj.href.lastIndexOf('/') + 1);
  
  let lines = m3u8Content.split('\n');
  
  lines = lines.map(line => {
    line = line.trim();
    
    // Skip comments and empty lines
    if (!line || line.startsWith('#')) {
      // Handle EXT-X-KEY URI rewriting
      if (line.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
          const absoluteUrl = new URL(uri, basePath).href;
          return `URI="/proxy-stream?url=${encodeURIComponent(absoluteUrl)}"`;
        });
      }
      return line;
    }
    
    // Rewrite segment URLs
    if (line.startsWith('http')) {
      return `/proxy-stream?url=${encodeURIComponent(line)}`;
    } else {
      // Relative URL
      const absoluteUrl = new URL(line, basePath).href;
      return `/proxy-stream?url=${encodeURIComponent(absoluteUrl)}`;
    }
  });
  
  return lines.join('\n');
}

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}