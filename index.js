
const { EventEmitter } = require('events')
const typeforce = require('typeforce')
const debug = require('debug')('tradle:onfido')
const sublevel = require('level-sublevel')
const secondary = require('level-secondary')
const Promise = require('bluebird')
const co = Promise.coroutine
const collect = Promise.promisify(require('stream-collector'))
const OnfidoTypes = require('@tradle/onfido-api/lib/types')
// const convert = require('./convert')
const { extend, omit } = require('./utils')
const DB_OPTS = { valueEncoding: 'json' }
const DEV = process.env.NODE_ENV !== 'production'
// const promisesub = function (db, prefix, opts=DB_OPTS) {
//   return Promise.promisifyAll(sub(db, prefix, opts))
// }

// const getCheckStatus = status.getCheckStatus
// const DEV = require('./dev')

const types = {
  applicantProps: typeforce.compile({
    firstName: typeforce.String,
    lastName: typeforce.String,
    email: typeforce.maybe(typeforce.String),
    gender: typeforce.maybe(typeforce.String),
  }),
  document: typeforce.compile({
    link: typeforce.String,
    type: OnfidoTypes.docType,
    file: typeforce.Buffer,
    filename: typeforce.String,
    side: typeforce.maybe(typeforce.String)
  }),
  photo: typeforce.compile({
    link: typeforce.String,
    file: typeforce.Buffer,
    filename: typeforce.String
  })
}

module.exports = createClient

function createClient (opts) {
  typeforce({
    api: typeforce.Object,
    db: typeforce.Object
  }, opts)

  let { api, db } = opts
  db = Promise.promisifyAll(sublevel(db))

  // {
  //   onfido: {
  //     // onfido applicant object
  //   },
  //   personalInfo: {
  //     // tradle personalInfo object
  //   }
  // }

  const applicants = Promise.promisifyAll(db.sublevel('a', DB_OPTS))
  const webhooks = Promise.promisifyAll(db.sublevel('w', DB_OPTS))
  // webhooks.url = secondary(webhooks, 'url', function (data) {
  //   return data.url + '!' + data.id
  // })

  // webhooks.url = Promise.promisifyAll(webhooks.url)

  const pendingChecks = Promise.promisifyAll(db.sublevel('c', DB_OPTS))
  pendingChecks.id = secondary(pendingChecks, 'id', function (check) {
    return check.onfido.id
  })

  pendingChecks.id = Promise.promisifyAll(pendingChecks.id)

  const createApplicant = co(function* createApplicant (opts) {
    typeforce({
      applicant: typeforce.String,
      props: types.applicantProps
    }, opts)

    const applicant = {
      permalink: opts.applicant,
      onfido: yield api.applicants.create(toOnfidoApplicant(opts.props)),
      props: opts.props,
      documents: [],
      photos: [],
      checks: []
    }

    yield applicants.putAsync(opts.applicant, applicant)
    debug('created applicant', opts.applicant)
    return applicant
  })

  const updateApplicant = co(function* updateApplicant (opts) {
    typeforce({
      applicant: typeforce.String,
      props: typeforce.Object
    }, opts)

    const current = yield applicants.getAsync(opts.applicant)
    const oApplicant = yield api.applicants.update(current.onfido.id, toOnfidoApplicant(opts.props))
    yield applicants.putAsync(opts.applicant, {
      onfido: oApplicant,
      props: opts.props
    })
  })

  const listApplicants = co(function* () {
    return collect(applicants.createValueStream())
  })

  const uploadDocument = co(function* uploadDocument (opts) {
    typeforce({
      applicant: typeforce.String,
      document: types.document
    }, opts)

    yield ensureNoPendingCheck(opts.applicant)

    const applicant = yield applicants.getAsync(opts.applicant)
    const doc = yield api.applicants.uploadDocument(applicant.onfido.id, omit(opts.document, ['link']))
    applicant.documents.push({
      tradle: opts.document.link,
      onfido: doc
    })

    debug('uploaded document for', opts.applicant)
    yield applicants.putAsync(opts.applicant, applicant)
  })

  const uploadLivePhoto = co(function* uploadLivePhoto (opts) {
    typeforce({
      applicant: typeforce.String,
      photo: types.photo
    }, opts)

    yield ensureNoPendingCheck(opts.applicant)

    const applicant = yield applicants.getAsync(opts.applicant)
    const photo = yield api.applicants.uploadLivePhoto(applicant.onfido.id, omit(opts.photo, ['link']))
    applicant.photos.push({
      tradle: opts.photo.link,
      onfido: photo
    })

    debug('uploaded photo for', opts.applicant)
    yield applicants.putAsync(opts.applicant, applicant)
  })

  const ensureNoPendingCheck = co(function* (applicant) {
    try {
      yield pendingChecks.getAsync(applicant)
    } catch (err) {
      return
    }

    throw new Error('wait till the current check is resolved')
  })

  const createCheck = co(function* createCheck (opts) {
    typeforce({
      applicant: typeforce.String,
      checkDocument: typeforce.maybe(typeforce.Boolean),
      checkFace: typeforce.maybe(typeforce.Boolean),
      result: typeforce.maybe(typeforce.String)
    }, opts)

    const permalink = opts.applicant
    const { checkDocument, checkFace } = opts
    if (!checkDocument && !checkFace) {
      throw new Error('expected "checkDocument" and/or "checkFace"')
    }

    yield ensureNoPendingCheck(permalink)

    const applicant = yield applicants.getAsync(permalink)
    const reports = []
    if (checkDocument) {
      if (!applicant.documents.length) {
        throw new Error('upload document before creating a check')
      }

      reports.push({ name: 'document' })
    }

    if (checkFace) {
      if (!applicant.photos.length) {
        throw new Error('upload a photo before creating a check')
      }

      reports.push({ name: 'facial_similarity' })
    }

    const applicantId = applicant.onfido.id
    const check = {
      onfido: yield api.checks.create(applicantId, { reports }),
      applicant: permalink,
      applicantId: applicantId,
      checkFace,
      checkDocument
    }

    debug('created check for', permalink)
    if (DEV && opts.result) {
      check.onfido.result = opts.result
      check.onfido.reports.forEach(r => r.result = opts.result)
    }

    if (applicant.documents.length) {
      check.latestDocument = last(applicant.documents).tradle
    }

    if (applicant.photos.length) {
      check.latestPhoto = last(applicant.photos).tradle
    }

    yield processCheck(check)
    // yield applicants.putAsync(opts.applicant, applicant)
  })

  const updatePendingCheck = co(function* updatePendingCheck (opts) {
    typeforce({
      applicant: typeforce.maybe(typeforce.String),
      check: typeforce.maybe(typeforce.Object)
    }, opts)

    const { applicant, check } = opts
    if (!check) {
      if (!applicant) throw new Error('expected "applicant" or "check"')
      check = yield getPendingCheck(applicant)
    }

    check.onfido = yield api.checks.get({
      applicantId: check.applicantId,
      checkId: check.onfido.id
    })

    yield processCheck(check)
    debug('updated check for', check.applicant)
  })

  const processCheck = co(function* processCheck (check) {
    const { result, status } = check.onfido
    check.status = status
    check.result = result
    const permalink = check.applicant
    if (status.indexOf('complete') !== 0) {
      yield pendingChecks.putAsync(permalink, check)
      return
    }

    const applicant = yield applicants.getAsync(permalink)
    applicant.checks.push(check)
    yield Promise.all([
      applicants.putAsync(permalink, applicant),
      pendingChecks.delAsync(permalink)
    ])

    debug(`check for ${permalink} completed with result: ${result}`)

    const data = extend({
      applicant: applicant.permalink,
    }, check)

    ee.emit('check', data)
    // allow subscribing to 'check:consider', 'check:complete'
    ee.emit('check:' + result, data)
  })

  const getPendingCheck = co(function* getPendingCheck (applicant) {
    return yield pendingChecks.getAsync(applicant)
  })

  const getApplicant = co(function* getApplicant (applicant) {
    return yield applicants.getAsync(applicant)
  })

  const getCheckById = co(function* getCheckById (id) {
    return yield pendingChecks.id.getAsync(id)
  })

  const processEvent = co(function* processEvent (req, res, desiredResult) {
    let event
    try {
      event = yield api.webhooks.handleEvent(req)
    } catch (err) {
      debug(err)
      return res.status(500).end()
    }

    const { resource_type, action, object } = event
    if (DEV && desiredResult) object.result = desiredResult

    try {
      if (resource_type === 'check') {
        if (action === 'check.completed') {
          const check = yield getCheckById(object.id)
          yield updatePendingCheck({ check })
        }
      }
    } catch (err) {
      debug(err)
      return res.status(500).end()
    }

    res.status(200).end()
  })

  const registerWebhook = co(function* registerWebhook ({ url, events }) {
    const existing = yield webhooks.getAsync(url)
    if (existing) throw new Error('webhook already registered')

    const webhook = yield api.webhooks.register({ url, events })
    yield webhooks.putAsync(webhook.url, webhook)
    return webhook
  })

  const unregisterWebhook = co(function* unregisterWebhook (url) {
    const existing = yield webhooks.getAsync(url)
    if (!existing) throw new Error('webhook not found')

    const webhook = yield api.webhooks.unregister(url)
    yield webhooks.delAsync(webhook.url)
    return webhook
  })

  const getOnfidoResource = co(function* (id) {
    return db.getOnfidoResource(id)
  })

  let pendingChecksStream
  const close = co(function* () {
    pendingChecksStream.destroy()
    yield db.closeAsync()
  })

  const ee = new EventEmitter()
  const start = co(function* start () {
    pendingChecksStream = pendingChecks.createValueStream()
      .on('data', pending => {
        updatePendingCheck({ applicant: pending.applicant })
      })
      .on('error', err => ee.emit('error', err))
  })

  start()

  const client = extend(ee, {
    applicants: {
      list: listApplicants,
      get: getApplicant,
      create: createApplicant,
      update: updateApplicant
    },
    checks: {
      create: createCheck,
      pending: getPendingCheck
    },
    uploadDocument,
    uploadLivePhoto,
    processEvent,
    close
  })

  return client
}

// function getPendingCheck (applicant) {
//   return applicant.checks.some(c => c.onfido.status !== 'complete')
// }

function last (arr) {
  return arr.length ? arr[arr.length - 1] : undefined
}

function toOnfidoApplicant (props) {
  const copy = {}
  for (var p in props) {
    let op = p
    if (p === 'firstName') op = 'first_name'
    if (p === 'lastName') op = 'last_name'

    copy[op] = props[p]
  }

  return copy
}
