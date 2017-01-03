const { EventEmitter } = require('events')
const Promise = require('bluebird')
const co = Promise.coroutine
const typeforce = require('typeforce')
const collect = Promise.promisify(require('stream-collector'))
const memdown = require('memdown')
const levelup = require('levelup')
const createOnfido = require('../')

module.exports = {
  client: mockClient,
  api: mockAPI
}

let dbCounter = 0

function mockClient (opts) {
  const api = mockAPI(opts)
  return createOnfido({
    api: api,
    db: levelup('db' + (dbCounter++), { db: memdown })
  })
}

function mockAPI ({ applicants, documents, checks, reports }) {
  return {
    applicants: {
      create: function (obj) {
        typeforce({
          first_name: typeforce.String,
          last_name: typeforce.String,
          email: typeforce.String
         }, obj)

        return Promise.resolve(applicants.shift())
      },
      update: function (id, obj) {
        typeforce(typeforce.String, id)
        typeforce(typeforce.Object, obj)
        return Promise.resolve(applicants.shift())
      },
      uploadDocument: function (id, obj) {
        typeforce(typeforce.String, id)
        typeforce({
          type: typeforce.String
        }, obj)

        return Promise.resolve(documents.shift())
      },
      uploadLivePhoto: function (id, obj) {
        typeforce(typeforce.String, id)
        typeforce(typeforce.Object, obj)
        return Promise.resolve({
          id: 'abc'
        })
      }
    },
    checks: {
      get: function (opts) {
        typeforce({
          checkId: typeforce.String,
          expandReports: typeforce.maybe(typeforce.Boolean)
        }, opts)

        return Promise.resolve(checks.shift())
      },
      create: function (id, opts) {
        typeforce(typeforce.String, id)
        typeforce({
          reports: typeforce.Array
        }, opts)

        return Promise.resolve(checks.shift())
      },
      createDocumentCheck: function (id) {
        typeforce(typeforce.String, id)
        return Promise.resolve(checks.shift())
      }
    },
    reports: {
      get: function (id) {
        typeforce(typeforce.String, id)

        if (report) {
          return Promise.resolve(reports.shift())
        }

        const match = check.reports.find(r => r.id === id)
        if (match) Promise.resolve(match)
        else Promise.reject(new Error('report not found'))
      }
    },
    webhooks: {
      handleEvent: co(function* (req) {
        const body = yield collect(req)
        return JSON.parse(body).payload
      })
    }
  }
}
