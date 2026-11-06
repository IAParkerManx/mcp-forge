package com.example.pocketnotes;

import android.app.Activity;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Bundle;

/** Adds a note from intent extras: title (required), body, pinned. */
public class AddNoteActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String title = getIntent().getStringExtra("title");
        String body = getIntent().getStringExtra("body");
        boolean pinned = getIntent().getBooleanExtra("pinned", false);
        if (title != null) {
            ContentValues values = new ContentValues();
            values.put("title", title);
            values.put("body", body == null ? "" : body);
            values.put("pinned", pinned ? 1 : 0);
            getContentResolver().insert(Uri.parse("content://" + NotesProvider.AUTHORITY + "/notes"), values);
        }
        finish();
    }
}
