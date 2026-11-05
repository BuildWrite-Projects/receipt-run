/* Receipt Run — connection settings.
   Same Supabase project as Field Measure and Job Book. These two values are
   meant to be public: the publishable key can only do what the database's Row
   Level Security allows, which for Receipt Run is "your own receipts, signed
   in, and nobody else". Never put a key labelled "secret" in this file. */
window.RR_CONFIG = {
  supabaseUrl: 'https://hnrwtrwatephqeifnbia.supabase.co',
  supabaseKey: 'sb_publishable_7EEnUfnh1z2OQ68F3GbEKA_cmyZ5WjP',
  bucket: 'receiptrun'
};
