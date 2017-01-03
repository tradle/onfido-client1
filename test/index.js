
const Promise = require('bluebird')
const co = Promise.coroutine
const test = require('tape')
const parseDataUri = require('parse-data-uri')
const PassThrough = require('readable-stream').PassThrough
const { shallowClone } = require('../utils')
const createOnfido = require('../')
// const convert = require('../convert')
const mock = require('./mock')
const fixtures = {
  applicants: require('./fixtures/applicants'),
  checks: require('./fixtures/checks'),
  documents: require('./fixtures/documents'),
  documentImages: require('./fixtures/document-images'),
  tradle: require('./fixtures/tradle'),
  inputs: require('./fixtures/inputs')
}

fixtures.inputs.license.file = parseDataUri(fixtures.inputs.license.file).data
fixtures.inputs.selfie.file = parseDataUri(fixtures.inputs.selfie.file).data

test('create applicant', co(function* (t) {
  const applicant = fixtures.applicants[0]
  const applicantId = applicant.id
  const onfido = mock.client({ applicants: [applicant] })
  const permalink = 'joe'
  const props = fixtures.inputs.applicant
  yield onfido.applicants.create({
    applicant: permalink,
    props
  })

  const applicants = yield onfido.applicants.list()
  t.equal(applicants.length, 1)
  t.same(applicants[0], {
    permalink: permalink,
    onfido: applicant,
    props: props,
    documents: [],
    photos: [],
    checks: []
  })

  t.end()
}))

test('basic', co(function* (t) {
  const result = 'clear'
  const applicant = fixtures.applicants[0]
  const applicantId = applicant.id
  const check = adjustCheck(fixtures.checks[applicantId][1], { result: null, status: 'in_progress' })
  const document = fixtures.documents[applicantId][0]
  const pendingReport = check.reports[0]
  const completeCheck = adjustCheck(check, { status: 'complete', result })
  const onfido = mock.client({
    applicants: [applicant],
    checks: [check, completeCheck],
    documents: [document]
  })

  const permalink = 'joe'
  yield onfido.applicants.create({
    applicant: permalink,
    props: fixtures.inputs.applicant
  })

  try {
    yield onfido.checks.create({ applicant: permalink, checkDocument: true })
    t.fail('should not be able to create check before uploading a document')
  } catch (err) {
    t.ok(/upload document/.test(err.message))
  }

  const license = fixtures.inputs.license
  const photo = fixtures.inputs.selfie
  yield onfido.uploadDocument({
    applicant: permalink,
    document: license
  })

  try {
    yield onfido.checks.create({ applicant: permalink, checkDocument: true, checkFace: true })
    t.fail('should not be able to create a face check before uploading a live photo')
  } catch (err) {
    t.ok(/upload a photo/.test(err.message))
  }

  yield onfido.uploadLivePhoto({
    applicant: permalink,
    photo: photo
  })

  yield onfido.checks.create({
    applicant: permalink,
    checkDocument: true,
    checkFace: true
  })

  const pending = yield onfido.checks.pending(permalink)
  t.same(pending, {
    applicant: permalink,
    applicantId: applicantId,
    onfido: check,
    latestDocument: license.link,
    latestPhoto: photo.link,
    checkDocument: true,
    checkFace: true,
    result: null,
    status: 'in_progress'
  })

  const webhookReq = new PassThrough()
  webhookReq.write(JSON.stringify({
    payload: {
      resource_type: 'check',
      action: 'check.completed',
      object: {
        id: check.id,
        status: 'completed',
        completed_at: new Date().toJSON(), // for correct format
        href: check.href,
        reports: completeCheck.reports
      }
    }
  }))

  webhookReq.end()

  const webhookRes = {
    status: function (code) {
      t.equal(code, 200)
      return webhookRes
    },
    end: function () {
      // t.pass()
    }
  }

  const awaitEvent = new Promise(resolve => {
    onfido.on('check:' + result, function (check) {
      t.equal(check.applicant, permalink)
      t.equal(check.latestDocument, license.link)
      t.equal(check.latestPhoto, photo.link)
      t.equal(check.result, result)
      t.equal(check.status, 'complete')
      resolve()
    })
  })

  yield onfido.processEvent(webhookReq, webhookRes)
  try {
    yield onfido.checks.pending(permalink)
    t.fail('should not have pending check')
  } catch (err) {}

  yield awaitEvent

  t.end()
}))

function adjustCheck (obj, props) {
  const copy = shallowClone(obj, props)
  if (copy.reports) {
    copy.reports = copy.reports.map(r => {
      return shallowClone(r, props)
    })
  }

  return copy
}
