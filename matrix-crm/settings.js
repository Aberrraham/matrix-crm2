'use strict';
// The lists customers choose from. Edit them here, then restart the server.
// IMPORTANT: customers in the same team are found by matching Date + Time slot + Theme EXACTLY,
// so keep the spelling consistent. If you rename a theme or slot, old waivers keep the old name.

module.exports = {
  OCCUPATIONS: [
    'Self Employed',
    'Chief Of Officers',
    'Home makers',
    'Corporate - Tech',
    'Corporate Non Tech',
    'Travellers',
    'Healthcare',
    'Students - School',
    'Student - College/Uni',
    'Education',
  ],

  HEARD_FROM: ['Instagram', 'Google search', 'Friend or family', 'YouTube', 'Walked past', 'Other'],

  THEMES: ['Lost Mummy', 'Forbidden Temple', 'Zombie Apocalypse', 'Cursed Castle', 'Mental Asylum'],

  SLOTS: ['11:00 AM', '12:30 PM', '2:00 PM', '3:30 PM', '5:00 PM', '6:30 PM', '8:00 PM'],

  // Customers can sign a waiver for today, or up to this many days ahead.
  // They cannot pick a past date, so nobody can join an old team to see its photos.
  WAIVER_DAYS_AHEAD: 30,

  // Points the owner of a referral code earns each time a friend's use of it is reported by the coupon website.
  // PLACEHOLDER: the real amount will be decided later. Change it here and restart.
  POINTS_PER_REFERRAL: 100,

  MAX_IMAGE_BYTES: 15 * 1024 * 1024,
  // Supabase's free plan allows 50 MB per file. Raise MAX_VIDEO_MB only after raising the limit in Supabase.
  MAX_VIDEO_BYTES: (Number(process.env.MAX_VIDEO_MB) || 50) * 1024 * 1024,
};
