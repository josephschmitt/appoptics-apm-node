'use strict'

const requirePatch = require('../require-patch')
const WeakMap = require('es6-weak-map')
const shimmer = require('shimmer')
const semver = require('semver')
const utility = require('../utility')
const rum = require('../rum')
const path = require('path')
const ao = require('..')
const log = ao.loggers
const Span = ao.Span
const conf = ao.probes.hapi

const notFunction = 'hapi - %s is not a function'
const protoNotFound = 'hapi - %s.prototype not found'

const trackedRenders = new WeakMap()
function wrapPrepare (request) {
  if (typeof request.prepare !== 'function') {
    log.patching(notFunction, 'request.prepare')
    return
  }
  shimmer.wrap(request, 'prepare', fn => function (response, callback) {
    const last = Span.last
    if (!last || !conf.enabled) {
      return fn.call(this, response, callback)
    }

    try {
      const filename = response.source.template
      const span = last.descend('hapi-render', {
        TemplateFile: filename,
        TemplateLanguage: path.extname(filename) || this._defaultExtension,
      })

      trackedRenders.set(response, span)
      span.async = true
      span.enter()
    } catch (e) {
      log.error('hapi - failed to enter hapi-render span')
    }

    return fn.call(this, response, callback)
  })
}

function wrapMarshal (request) {
  if (typeof request.marshal !== 'function') {
    log.patching(notFunction, 'request.marshal')
    return
  }
  shimmer.wrap(request, 'marshal', fn => function (response, callback) {
    const span = trackedRenders.get(response)
    if (!span || !conf.enabled) {
      return fn.call(this, response, callback)
    }

    try {
      response.source.context = response.source.context || {}
      if (ao.rumId) {
        const topSpan = ao.requestStore.get('topSpan')
        rum.inject(response.source.context, ao.rumId, topSpan.events.exit)
      }
    } catch (e) {
      log.error('hapi - rum.inject failed')
    }

    return fn.call(this, response, utility.before(() => span.exit(), callback))
  })
}

function wrapPrepareMarshal (request) {
  wrapPrepare(request)
  wrapMarshal(request)
}

function wrapManager (manager) {
  if (typeof manager._response !== 'function') {
    log.patching(notFunction, 'manager._response')
    return
  }
  shimmer.wrap(manager, '_response', fn => function () {
    const ret = fn.apply(this, arguments)
    wrapPrepareMarshal(ret._processors || {})
    return ret
  })
}

function wrapRender (render, version) {
  if (typeof render !== 'function') {
    log.patching(notFunction, 'render')
    return render
  }
  return function (filename, context, options, callback) {
    context = context || {}

    const run = version && semver.satisfies(version, '< 1.1.0')
      ? cb => render.call(this, filename, context, options, cb)
      : () => render.call(this, filename, context, options)

    return ao.instrument(
      last => {
        if (ao.rumId) {
          const topSpan = ao.requestStore.get('topSpan')
          rum.inject(context, ao.rumId, topSpan.events.exit)
        }

        return last.descend('hapi-render', {
          TemplateFile: filename,
          TemplateLanguage: path.extname(filename) || this._defaultExtension,
        })
      },
      run,
      conf,
      callback
    )
  }
}

const patchedViews = new WeakMap()
function patchView (view, version) {
  if (typeof view.render !== 'function') {
    log.patching(notFunction, 'view.render')
    return
  }
  if (patchedViews.get(view)) return
  patchedViews.set(view, true)
  shimmer.wrap(view, 'render', render => wrapRender(render, version))
}

function patchConnection (conn) {
  if (typeof conn.views !== 'function') {
    log.patching(notFunction, 'connection.views')
    return
  }

  function findViews (ctx) {
    return ctx._views ? ctx._views : (
      ctx.pack && ctx.pack._env.views ? ctx.pack._env.views : (
        ctx._server && ctx._server._env.views
      )
    )
  }

  shimmer.wrap(conn, 'views', fn => function () {
    const ret = fn.apply(this, arguments)
    const views = findViews(this)
    const proto = views && views.constructor && views.constructor.prototype
    if (proto) {
      patchView(proto)
    } else {
      log.patching(protoNotFound, 'views.constructor')
    }
    return ret
  })
}

function patchGenerator (generator) {
  if (typeof generator.request !== 'function') {
    log.patching(notFunction, 'generator.request')
    return
  }
  shimmer.wrap(generator, 'request', fn => function () {
    const ret = fn.apply(this, arguments)
    patchRequest(ret)
    return ret
  })
}

function patchRequest (request) {
  if (typeof request._execute !== 'function') {
    log.patching(notFunction, 'request._execute')
    return
  }

  // The route argument existed from 1.2.0 and older
  shimmer.wrap(request, '_execute', execute => function (route) {
    const {res} = this.raw
    ao.instrumentHttp(
      last => {
        ao.addResponseFinalizer(res, () => {
          const {exit} = res._ao_http_span.events
          const route = this._route || {}
          const {handler = {}} = route.settings || {}
          exit.Controller = route.path
          exit.Action = utility.fnName(handler)
        })
        return last.descend('hapi')
      },
      execute.bind(this, route),
      conf,
      res
    )
  })
}

function patchDecorator (plugin, version) {
  if (typeof plugin.decorate !== 'function') {
    log.patching(notFunction, 'plugin.decorator')
    return
  }

  function wrapViews (views) {
    if (typeof views !== 'function') {
      log.patching(notFunction, 'plugin.decorator.views')
      return views
    }
    return function () {
      const ret = views.apply(this, arguments)

      const {plugins} = this.realm || {}
      const manager = plugins && plugins.vision && plugins.vision.manager
      if (manager) {
        if (version && semver.satisfies(version, '>= 9.0.0')) {
          wrapManager(manager)
        } else {
          manager.render = wrapRender(manager.render, version)
        }
      }

      return ret
    }
  }

  shimmer.wrap(plugin, 'decorate', fn => function (name, method, handler, options) {
    if (name === 'server' && method === 'views') {
      handler = wrapViews(handler)
    }
    return fn.call(this, name, method, handler, options)
  })
}

//
// Apply hapi patches
//
module.exports = function (hapi) {
  const {version} = requirePatch.relativeRequire('hapi/package.json')

  let Request
  try {
    Request = requirePatch.relativeRequire('hapi/lib/request')
  } catch (e) {}
  if (Request && Request.prototype) {
    if (semver.satisfies(version, '>= 8.5.0')) {
      patchGenerator(Request.prototype)
    } else {
      patchRequest(Request.prototype)
    }
  } else {
    log.patching(protoNotFound, 'Request')
  }

  // After 8.0.0, the Plugin system was introduced
  if (semver.satisfies(version, '>= 8.0.0')) {
    let Plugin
    try {
      Plugin = requirePatch.relativeRequire('hapi/lib/plugin')
    } catch (e) {}
    if (Plugin && Plugin.prototype) {
      patchDecorator(Plugin.prototype, version)
    } else {
      log.patching(protoNotFound, 'Plugin')
    }

  // After 7.2.0, Server became Connection
  } else if (semver.satisfies(version, '>= 7.2.0')) {
    let Connection
    try {
      Connection = requirePatch.relativeRequire('hapi/lib/connection')
    } catch (e) {}
    if (Connection && Connection.prototype) {
      patchConnection(Connection.prototype)
    } else {
      log.patching(protoNotFound, 'Connection')
    }

  // After 2.0.0, View was not patchable directly
  } else if (semver.satisfies(version, '>= 6.0.0')) {
    let Server
    try {
      Server = requirePatch.relativeRequire('hapi/lib/server')
    } catch (e) {}
    if (Server && Server.prototype) {
      patchConnection(Server.prototype)
    } else {
      log.patching(protoNotFound, 'Server')
    }

  // Beyond that, we can patch View directly
  } else {
    let View
    try {
      View = requirePatch.relativeRequire('hapi/lib/views')
    } catch (e) {}
    let patched = false
    if (View) {
      if (semver.satisfies(version, '> 2.0.0')) {
        if (View.Manager && View.Manager.prototype) {
          patchView(View.Manager.prototype)
          patched = true
        }
      } else if (View.prototype) {
        patchView(View.prototype, version)
        patched = true
      }
    }
    if (!patched) {
      log.patching('hapi - views not patched')
    }
  }

  return hapi
}
