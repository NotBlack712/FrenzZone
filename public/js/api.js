// Thin wrapper around fetch() for talking to the local API.
const api = {
  async request(method, url, body, isFormData = false) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body) {
      if (isFormData) {
        opts.body = body; // browser sets multipart headers itself
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body, isFormData) { return this.request('PUT', url, body, isFormData); },
  patch(url, body) { return this.request('PATCH', url, body); },
  postForm(url, formData) { return this.request('POST', url, formData, true); },
  // Optional body: DELETE /api/settings/account must send { password, confirm },
  // while every other DELETE in the app still passes nothing.
  del(url, body) { return this.request('DELETE', url, body); }
};
