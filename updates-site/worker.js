// rewatch.ggwp.no: where the app looks for new versions, where the installer is
// downloaded from, and the landing page. Files come from one storage bucket:
//
//   latest.json                      which version is newest, and its signature
//   Rewatch_<version>_x64-setup.exe  the installers
//   media/<name>                     the landing page's footage and pictures
//
// Nothing here is secret: the app only runs an installer whose signature matches the
// key built into it, so a file that was swapped out would be refused.

import PAGE from "./page.html";
import DEMO from "./demo.json";
import ARCHIVO from "./fonts/archivo.woff2";
import GEIST from "./fonts/geist.woff2";

const INSTALLER = /^Rewatch_[0-9A-Za-z.]+_x64-setup\.exe$/;
const MEDIA = /^[a-z0-9][a-z0-9._-]*\.(mp4|webp|jpg)$/;
const MEDIA_TYPES = { mp4: "video/mp4", webp: "image/webp", jpg: "image/jpeg" };
const FONTS = { "/fonts/archivo.woff2": ARCHIVO, "/fonts/geist.woff2": GEIST };

// The demo's data (one real recorded game: timeline, cursor, drawings, review) goes into
// the page as JSON. "<" is escaped so nothing in it can close the script tag.
const DEMO_JSON = JSON.stringify(DEMO).replace(/</g, "\\u003c");

async function latest(env) {
  const obj = await env.RELEASES.get("latest.json");
  return obj ? await obj.json() : null;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// page.html marks its download buttons with <!--cta--> and <!--cta-nav-->. Before the
// first version is published they're swapped for a note, so no button leads to a 404.
function page(info) {
  let html = PAGE.replace("{{demo}}", () => DEMO_JSON);
  if (info?.version) {
    const line = `Version ${esc(info.version)} for 64-bit Windows 10 and 11, about 30 MB. It keeps itself up to date.`;
    return html.replace("{{version-line}}", line);
  }
  return html
    .replace(/<!--cta-nav-->[\s\S]*?<!--\/cta-nav-->/g, "")
    .replace(/<!--cta-->[\s\S]*?<!--\/cta-->/g, `<p class="not-yet">The first version isn't out yet.</p>`)
    .replace("{{version-line}}", "");
}

// Footage is served from the bucket with range support, which Safari needs to play video.
// A single "bytes=a-b", "bytes=a-" or "bytes=-n" range; anything else gets the whole file.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start <= end && start < size ? { offset: start, length: end - start + 1 } : "invalid";
}

async function media(request, env, name) {
  const key = `media/${name}`;
  const meta = await env.RELEASES.head(key);
  if (!meta) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "Content-Type": MEDIA_TYPES[name.split(".").pop()],
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=604800",
    ETag: meta.httpEtag,
  });
  const range = parseRange(request.headers.get("Range"), meta.size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${meta.size}`);
    return new Response(null, { status: 416, headers });
  }
  const head = request.method === "HEAD";
  const obj = head ? meta : await env.RELEASES.get(key, range ? { range } : {});
  if (!obj) return new Response("Not found", { status: 404 });
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(head ? null : obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(head ? null : obj.body, { headers });
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const path = new URL(request.url).pathname;

    if (path === "/latest.json") {
      const info = await latest(env);
      if (!info) return new Response("Not found", { status: 404 });
      return Response.json(info, { headers: { "Cache-Control": "no-cache" } });
    }

    if (path === "/download/latest") {
      const info = await latest(env);
      const url = info?.platforms?.["windows-x86_64"]?.url;
      return url ? Response.redirect(url, 302) : new Response("Not found", { status: 404 });
    }

    if (path.startsWith("/download/")) {
      const name = path.slice("/download/".length);
      if (!INSTALLER.test(name)) return new Response("Not found", { status: 404 });
      const obj = await env.RELEASES.get(name);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : obj.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(obj.size),
          "Content-Disposition": `attachment; filename="${name}"`,
          // A version's installer never changes once published.
          "Cache-Control": "public, max-age=86400, immutable",
          ETag: obj.httpEtag,
        },
      });
    }

    if (path.startsWith("/media/")) {
      const name = path.slice("/media/".length);
      if (!MEDIA.test(name)) return new Response("Not found", { status: 404 });
      return media(request, env, name);
    }

    if (FONTS[path]) {
      return new Response(request.method === "HEAD" ? null : FONTS[path], {
        headers: { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }

    if (path === "/") {
      return new Response(page(await latest(env)), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Robots-Tag": "noindex" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
