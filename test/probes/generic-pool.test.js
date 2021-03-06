'use strict'

const helper = require('../helper')
const semver = require('semver')
const should = require('should')
const ao = helper.ao
const log = ao.loggers

const gp = require('generic-pool')

// execute tests conditionally
const pkg = require('generic-pool/package')
const v3 = semver.satisfies(pkg.version, '>= 3')
const ifv3 = v3 ? it : it.skip
const ifv2 = v3 ? it.skip : it

const hasAsync = semver.satisfies(process.version, '>= 8')

let n = 0
const max = 2
const foo = {bar: 'baz'}

let pool
if (!v3) {
  // v2 signature
  pool = new gp.Pool({
    name: 'test',
    create: function (cb) {
      if (n >= max) {
        cb('done')
      } else {
        n += 1
        cb(null, {bar: n})
      }
      cb(null, foo)
    },
    max: 2,
    min: 2
  })
} else {
  // v3 signature
  const factory = {
    create: function () {
      if (n >= max) {
        return Promise.reject()
      }
      n += 1
      return Promise.resolve({bar: n})
    },
    destroy: function (resource) {
      return Promise.resolve(true)
    }
  }
  const options = {
    max: 2,
    min: 2
  }
  pool = gp.createPool(factory, options)
}


describe('probes/generic-pool ' + pkg.version, function () {
  ifv2('should trace through generic-pool acquire for versions < 3', function (done) {
    //
    // v2 uses callbacks
    //
    let okToRelease = false

    function spanRunner (done) {
      log.debug('%s spanRunner %e', ao.lastEvent.Layer, ao.lastEvent)

      // use taskId and layer name to verify that the correct context is maintained across calls
      const span = ao.lastEvent.Layer
      const taskId = ao.lastEvent.taskId
      should.exist(taskId)
      ao.requestStore.set('key', span)

      pool.acquire(function (err, resource) {
        if (err) {
          done(err)
          return
        }
        log.debug('%s acquired(queue) %o for %e', span, resource, ao.lastEvent)

        should.exist(ao.lastEvent.Layer)
        ao.lastEvent.Layer.should.equal(span)
        taskId.should.be.equal(ao.lastEvent.taskId)

        const t = setInterval(function () {
          if (okToRelease) {
            log.debug('releasing %o by %e', resource, ao.lastEvent)

            should.exist(ao.lastEvent.Layer)
            ao.lastEvent.Layer.should.equal(span)
            taskId.should.be.equal(ao.lastEvent.taskId)

            pool.release(resource)
            clearInterval(t)
          }
        }, 10)
      })

      pool.acquire(function (err, resource) {
        if (err) {
          done(err)
          return
        }
        log.debug('%s acquired %o for %e', span, resource, ao.lastEvent)

        should(ao.requestStore.get('key')).equal(span)
        should.exist(ao.lastEvent.Layer)
        ao.lastEvent.Layer.should.equal(span)
        taskId.should.be.equal(ao.lastEvent.taskId)

        done()
      })
    }

    let count = 0
    function bothDone (e) {
      count += 1
      if (count === 2 || e) {
        done(e)
      }
    }

    ao.startOrContinueTrace('', 'generic-pool-1', spanRunner, function (e) {log.debug('gp-1'); bothDone(e)})
    ao.startOrContinueTrace('', 'generic-pool-2', spanRunner, function (e) {log.debug('gp-2'); bothDone(e)})

    okToRelease = true
  })

  ifv3('should trace through generic-pool acquire for versions > 3', function (done) {
    //
    // v3 uses promises
    //
    let okToRelease = false

    function spanRunner (done) {
      log.debug('%s spanRunner %e', ao.lastEvent.Layer, ao.lastEvent)

      // use taskId and layer name to verify that the correct context is maintained across calls
      const span = ao.lastEvent.Layer
      const taskId = ao.lastEvent.taskId
      should.exist(taskId)
      ao.requestStore.set('key', span)

      // acquire an entry in the pool and release it after an event loop interval.
      // this causes the the 'generic-pool-1' span to acquire both resources from the
      // pool and forces 'generic-pool-2' to wait until a resource is freed before its
      // promise is resolved.
      pool.acquire().then(function (resource) {
        log.debug('%s acquired(queue) %o for %e', span, resource, ao.lastEvent)

        should.exist(ao.lastEvent.Layer)
        ao.lastEvent.Layer.should.equal(span)
        taskId.should.be.equal(ao.lastEvent.taskId)

        const t = setInterval(function () {
          if (okToRelease) {
            log.debug('releasing %o by %e', resource, ao.lastEvent)

            should.exist(ao.lastEvent.Layer)
            ao.lastEvent.Layer.should.equal(span)
            taskId.should.be.equal(ao.lastEvent.taskId)

            pool.release(resource)
            clearInterval(t)
          }
        }, 10)
      }).catch(function (e) {
        done(e)
      })

      let acquire
      if (hasAsync) {
        // kind of ugly, but how else to get around JavaScript  < 8 issuing a
        // syntax error?
        eval('acquire = async function () {return await pool.acquire()}')
      } else {
        acquire = pool.acquire
      }

      //
      // now get the second resource when it's available. it should be available
      // immediately for the first trace but the second trace will have to wait until
      // the interval timer pops.
      //
      acquire().then(function (resource) {
        log.debug('%s acquired %o for %e', span, resource, ao.lastEvent)

        should(ao.requestStore.get('key')).equal(span)
        should.exist(ao.lastEvent.Layer)
        ao.lastEvent.Layer.should.equal(span)
        taskId.should.be.equal(ao.lastEvent.taskId)

        done()
      }).catch(function (e) {
        done(e)
      })
    }

    let count = 0
    function bothDone (e) {
      count += 1
      if (count === 2 || e) {
        done(e)
      }
    }

    ao.startOrContinueTrace('', 'generic-pool-1', spanRunner, function (e) {log.debug('gp-1'); bothDone(e)})
    ao.startOrContinueTrace('', 'generic-pool-2', spanRunner, function (e) {log.debug('gp-2'); bothDone(e)})

    okToRelease = true
  })
})
