var helper = require('../helper')
var ao = helper.ao
var addon = ao.addon


var canGenerator = false
try {
  eval('(function* () {})()')
  canGenerator = true
} catch (e) {
}

function noop () {}

describe('probes/koa-route', function () {
  var emitter
  var tests = canGenerator && require('./koa')

  //
  // Intercept appoptics messages for analysis
  //
  before(function (done) {
    ao.fs.enabled = false
    emitter = helper.appoptics(done)
    ao.sampleRate = ao.addon.MAX_SAMPLE_RATE
    ao.traceMode = 'always'
  })
  after(function (done) {
    ao.fs.enabled = true
    emitter.close(done)
  })

  //
  // Tests
  //
  if ( ! canGenerator) {
    it.skip('should support koa-route controllers', noop)
    it.skip('should skip when disabled', noop)
  } else {
    it('should support koa-route controllers', function (done) {
      tests.route(emitter, done)
    })
    it('should skip when disabled', function (done) {
      tests.route_disabled(emitter, done)
    })
  }
})
