const crypto = require('crypto')
const parseDataUri = require('parse-data-uri')
const { constants } = require('@tradle/engine')
const typemap = require('./typemap')
const { TYPE } = constants
const mimeTypeToExt = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
  'image/gif': 'gif',
}

function getExtension (mimeType) {
  return mimeTypeToExt[mimeType] || mimeType.split('/')[1]
}

module.exports = {
  toOnfido: function (object) {
    return clean(toOnfido(object))
  },
  toTradle: function (report, targetType='default') {
    const from = toTradle[report.document_type]
    if (!from) {
      throw new Error('unknown type: ' + report.document_type)
    }

    return clean(from[targetType](report))
  }
}

function toTradlePassport (passport) {
  return {
    [TYPE]: 'tradle.Passport',
    givenName: passport.first_name,
    surname: passport.last_name,
    passportNumber: passport.document_numbers[0].value,
    dateOfBirth: new Date(passport.date_of_birth).getTime(),
    dateOfExpiry: new Date(passport.date_of_expiry).getTime(),
    sex: {
      title: passport.gender
    },
    // nationality: models.data['tradle.Country'].find(c => c.code === issuing_country)
  }
}

const toTradle = {
  passport: {
    default: toTradlePassport,
    'tradle.Passport': toTradlePassport,
    'tradle.PersonalInfo': function (passport) {
      return {
        [TYPE]: 'tradle.Passport',
        firstName: passport.first_name,
        lastName: passport.last_name,
        idCardType: {
          title: "Passport"
        },
        idCardNumber: passport.document_numbers[0].value,
        dateOfBirth: new Date(passport.date_of_birth).getTime(),
        sex: {
          title: passport.gender
        }
      }
    }
  }
}

function toOnfido (object) {
  const type = object[TYPE]
  if (type === 'tradle.PersonalInfo') {
    let mobile = (object.phones || []).find(phone => phone.phoneType.title === 'phoneType')
    if (mobile) mobile = mobile.number
    return {
      first_name: object.firstName,
      last_name: object.lastName,
      email: object.emailAddress,
      gender: object.sex && object.sex.title,
      mobile: mobile
    }
  } else if (type === 'tradle.Selfie') {
    const photos = object.selfie || object.photos
    const { data, mimeType } = parseDataUri(photos[0].url)
    return {
      file: data,
      filename: `face-${digest(data)}.${getExtension(mimeType)}`
    }
  }

  const onfidoType = toOnfidoType(type)
  const { data, mimeType } = parseDataUri(object.photos[0].url)
  return {
    type: onfidoType,
    file: data,
    filename: `${onfidoType}-${digest(data)}.${getExtension(mimeType)}`,
    side: hasTwoSides(onfidoType) ? undefined : 'front'
  }
}

function hasTwoSides (onfidoType) {
  return onfidoType !== 'passport'
}

function toOnfidoType (type) {
  const onfidoType = typemap[type]
  if (onfidoType) return onfidoType

  throw new Error('unknown type: ' + type)
}

function clean (obj) {
  const noUndefineds = {}
  for (var p in obj) {
    if (obj[p] !== undefined) noUndefineds[p] = obj[p]
  }

  return noUndefineds
}

function digest (data) {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 7)
}
