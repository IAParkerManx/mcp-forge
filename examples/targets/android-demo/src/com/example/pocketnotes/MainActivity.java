package com.example.pocketnotes;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;

/** Shows the notes; pocketnotes://note/<id> opens one note. */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView view = new TextView(this);
        Uri data = getIntent().getData();
        String highlight = getIntent().getStringExtra("highlight");
        view.setText(data != null ? "Note " + data.getLastPathSegment() : highlight != null ? "Search: " + highlight : "PocketNotes");
        setContentView(view);
    }
}
