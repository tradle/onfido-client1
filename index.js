
const { EventEmitter } = require('events')
const typeforce = require('typeforce')
const debug = require('debug')('tradle:onfido')
const sublevel = require('level-sublevel')
const secondary = require('level-secondary')
const Promise = require('bluebird')
const co = Promise.coroutine
const collect = Promise.promisify(require('stream-collector'))
const { utils } = require('@tradle/engine')
const convert = require('./convert')
const DB_OPTS = { valueEncoding: 'json' }
const DEV = process.env.NODE_ENV !== 'production'
// const promisesub = function (db, prefix, opts=DB_OPTS) {
//   return Promise.promisifyAll(sub(db, prefix, opts))
// }

// const getCheckStatus = status.getCheckStatus
// const DEV = require('./dev')

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
      personalInfo: typeforce.Object
    }, opts)

    const applicant = {
      permalink: opts.applicant,
      onfido: yield api.applicants.create(convert.toOnfido(opts.personalInfo)),
      personalInfo: opts.personalInfo,
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
      personalInfo: typeforce.Object
    }, opts)

    const current = yield applicants.getAsync(opts.applicant)
    const oApplicant = yield api.applicants.update(current.onfido.id, convert.toOnfido(opts.personalInfo))
    yield applicants.putAsync(opts.applicant, {
      onfido: oApplicant,
      personalInfo: opts.personalInfo
    })
  })

  const listApplicants = co(function* () {
    return collect(applicants.createValueStream())
  })

  const uploadDocument = co(function* uploadDocument (opts) {
    typeforce({
      applicant: typeforce.String,
      document: typeforce.Object
    }, opts)

    yield ensureNoPendingCheck(opts.applicant)

    const applicant = yield applicants.getAsync(opts.applicant)
    const doc = yield api.applicants.uploadDocument(applicant.onfido.id, convert.toOnfido(opts.document))
    applicant.documents.push({
      tradle: {
        link: utils.hexLink(opts.document),
        object: opts.document
      },
      onfido: doc
    })

    debug('uploaded document for', opts.applicant)
    yield applicants.putAsync(opts.applicant, applicant)
  })

  const uploadLivePhoto = co(function* uploadLivePhoto (opts) {
    typeforce({
      applicant: typeforce.String,
      photo: typeforce.Object
    }, opts)

    yield ensureNoPendingCheck(opts.applicant)

    const applicant = yield applicants.getAsync(opts.applicant)
    const photo = yield api.applicants.uploadLivePhoto(applicant.onfido.id, convert.toOnfido(opts.photo))
    applicant.photos.push({
      tradle: {
        link: utils.hexLink(opts.photo),
        object: opts.photo
      },
      onfido: photo
    })

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
      checkFace: typeforce.maybe(typeforce.Boolean)
    }, opts)

    const permalink = opts.applicant
    const checkFace = opts.checkFace
    yield ensureNoPendingCheck(permalink)

    const applicant = yield applicants.getAsync(permalink)
    if (!applicant.documents.length) throw new Error('upload document before creating a check')

    const reports = [{ name: 'document' }]
    if (checkFace) {
      if (!applicant.photos.length) throw new Error('upload a photo before creating a check')

      reports.push({ name: 'facial_similarity' })
    }

    const applicantId = applicant.onfido.id
    const document = last(applicant.documents).tradle.object
    const check = {
      onfido: yield api.checks.create(applicantId, { reports }),
      applicant: permalink,
      applicantId: applicantId,
      document: utils.hexLink(document)
    }

    if (checkFace) {
      const photo = last(applicant.photos).tradle.object
      check.photo = utils.hexLink(photo)
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
  })

  const processCheck = co(function* processCheck (check) {
    const { result, status } = check.onfido
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

    ee.emit('check', {
      applicant: applicant.permalink,
      check: check
    })

    // allow subscribing to 'check:consider', 'check:complete'
    ee.emit('check:' + result, utils.extend({
      applicant: applicant.permalink,
    }, check))
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
    pendingChecksStream.end()
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

  return utils.extend(ee, {
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
    processEvent
  })
}

// function getPendingCheck (applicant) {
//   return applicant.checks.some(c => c.onfido.status !== 'complete')
// }

function last (arr) {
  return arr.length ? arr[arr.length - 1] : undefined
}
