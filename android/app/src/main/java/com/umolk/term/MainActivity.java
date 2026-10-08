package com.umolk.term;

import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.RadioGroup;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.GravityCompat;
import androidx.drawerlayout.widget.DrawerLayout;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.umolk.term.adapters.HostAdapter;
import com.umolk.term.adapters.SnippetAdapter;
import com.umolk.term.models.Snippet;
import com.umolk.term.models.SshHost;
import com.umolk.term.ssh.SshTerminalManager;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private DrawerLayout drawerLayout;
    private FrameLayout terminalStage;
    private TextView terminalOutput;
    private View voicePanel;
    private TextView voiceStateText;
    private TextView voiceTranscriptText;

    // Adapters & Lists
    private RecyclerView rvHostsList;
    private HostAdapter hostAdapter;
    private List<SshHost> hostList = new ArrayList<>();

    private List<Snippet> snippetList = new ArrayList<>();
    private SnippetAdapter snippetAdapter;
    private SshTerminalManager sshManager;

    private int currentFontSize = 12;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        sshManager = new SshTerminalManager();
        initViews();
        setupKeyBar();
        setupSampleData();
        setupDrawers();
    }

    private void initViews() {
        drawerLayout = findViewById(R.id.drawerLayout);
        terminalStage = findViewById(R.id.terminalStage);
        terminalOutput = findViewById(R.id.terminalOutput);
        voicePanel = findViewById(R.id.voicePanel);
        voiceStateText = findViewById(R.id.voiceStateText);
        voiceTranscriptText = findViewById(R.id.voiceTranscriptText);

        terminalOutput.setTextSize(currentFontSize);
        terminalOutput.setText("UmolkTerm v1.0 Ready. Select a host to connect.\n");

        // Header buttons
        findViewById(R.id.btnToggleSidebar).setOnClickListener(v -> 
            drawerLayout.openDrawer(GravityCompat.START));
        findViewById(R.id.btnToggleAi).setOnClickListener(v -> 
            drawerLayout.openDrawer(GravityCompat.END));
        findViewById(R.id.btnSettings).setOnClickListener(v -> showSettingsDialog());

        // Left drawer hosts RecyclerView
        rvHostsList = findViewById(R.id.rvHostsList);
        rvHostsList.setLayoutManager(new LinearLayoutManager(this));
        hostAdapter = new HostAdapter(hostList, new HostAdapter.OnHostClickListener() {
            @Override
            public void onConnect(SshHost host) {
                drawerLayout.closeDrawer(GravityCompat.START);
                terminalOutput.append("\n[Connecting to " + host.getLabel() + " (" + host.getHost() + ")...]\n");
                sshManager.connect(host, new SshTerminalManager.SshListener() {
                    @Override
                    public void onConnected() {
                        runOnUiThread(() -> terminalOutput.append("[SSH Connected]\n"));
                    }

                    @Override
                    public void onDataReceived(String data) {
                        runOnUiThread(() -> terminalOutput.append(data));
                    }

                    @Override
                    public void onError(String error) {
                        runOnUiThread(() -> terminalOutput.append("\n[" + error + "]\n"));
                    }

                    @Override
                    public void onDisconnected() {
                        runOnUiThread(() -> terminalOutput.append("\n[Disconnected]\n"));
                    }
                });
            }

            @Override
            public void onTest(SshHost host) {
                Toast.makeText(MainActivity.this, "Testing connection...", Toast.LENGTH_SHORT).show();
            }

            @Override
            public void onEdit(SshHost host) {
                showEditHostDialog(host);
            }

            @Override
            public void onDelete(SshHost host) {
                hostList.remove(host);
                hostAdapter.notifyDataSetChanged();
            }
        });
        rvHostsList.setAdapter(hostAdapter);

        findViewById(R.id.btnAddHost).setOnClickListener(v -> showEditHostDialog(null));
        findViewById(R.id.btnSidebarSnippets).setOnClickListener(v -> showSnippetsDialog());
    }

    private void setupKeyBar() {
        // Paste and Run
        findViewById(R.id.btnKeyPasteRun).setOnClickListener(v -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard != null && clipboard.hasPrimaryClip() && clipboard.getPrimaryClip().getItemCount() > 0) {
                CharSequence text = clipboard.getPrimaryClip().getItemAt(0).getText();
                if (text != null && text.length() > 0) {
                    terminalOutput.append("\n" + text + "\n");
                    sshManager.sendData(text.toString() + "\n");
                }
            } else {
                Toast.makeText(this, "Clipboard is empty", Toast.LENGTH_SHORT).show();
            }
        });

        // Voice Input
        findViewById(R.id.btnKeyMic).setOnClickListener(v -> {
            if (voicePanel.getVisibility() == View.VISIBLE) {
                voicePanel.setVisibility(View.GONE);
            } else {
                voicePanel.setVisibility(View.VISIBLE);
                voiceStateText.setText("Listening...");
                voiceTranscriptText.setText("");
            }
        });

        // Snippets button on key bar
        findViewById(R.id.btnKeySnippets).setOnClickListener(v -> showSnippetsDialog());

        // Standard keys
        findViewById(R.id.btnKeyEsc).setOnClickListener(v -> sshManager.sendData("\u001b"));
        findViewById(R.id.btnKeyTab).setOnClickListener(v -> sshManager.sendData("\t"));
        findViewById(R.id.btnKeyUp).setOnClickListener(v -> sshManager.sendData("\u001b[A"));
        findViewById(R.id.btnKeyDown).setOnClickListener(v -> sshManager.sendData("\u001b[B"));
        findViewById(R.id.btnKeyLeft).setOnClickListener(v -> sshManager.sendData("\u001b[D"));
        findViewById(R.id.btnKeyRight).setOnClickListener(v -> sshManager.sendData("\u001b[C"));
        findViewById(R.id.btnKeyPipe).setOnClickListener(v -> sshManager.sendData("|"));
        findViewById(R.id.btnKeyTilde).setOnClickListener(v -> sshManager.sendData("~"));
        findViewById(R.id.btnKeySlash).setOnClickListener(v -> sshManager.sendData("/"));
        findViewById(R.id.btnKeyMinus).setOnClickListener(v -> sshManager.sendData("-"));
    }

    private void setupSampleData() {
        hostList.add(new SshHost("1", "Production VPS", "54.224.238.91", 22, "admin", "password", "", "", "Cloud"));
        hostList.add(new SshHost("2", "Home Raspberry Pi", "192.168.1.100", 22, "pi", "password", "", "", "HomeLab"));
        hostAdapter.notifyDataSetChanged();

        snippetList.add(new Snippet("1", "Docker Status", "docker ps -a", "Docker"));
        snippetList.add(new Snippet("2", "Restart Nginx", "sudo systemctl restart nginx", "System"));
        snippetList.add(new Snippet("3", "Check Memory", "free -h", "System"));
    }

    private void setupDrawers() {
        // AI Copilot Drawer actions
        EditText etAiInput = findViewById(R.id.etAiInput);
        findViewById(R.id.btnSendAi).setOnClickListener(v -> {
            String prompt = etAiInput.getText().toString().trim();
            if (!prompt.isEmpty()) {
                Toast.makeText(this, "AI analyzing: " + prompt, Toast.LENGTH_SHORT).show();
                etAiInput.setText("");
            }
        });
    }

    private void showSettingsDialog() {
        Dialog dialog = new Dialog(this);
        dialog.setContentView(R.layout.dialog_settings);

        SeekBar sbFontSize = dialog.findViewById(R.id.sbFontSize);
        sbFontSize.setProgress(currentFontSize);

        sbFontSize.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                int size = Math.max(8, progress);
                currentFontSize = size;
                terminalOutput.setTextSize(currentFontSize);
            }
            @Override public void onStartTrackingTouch(SeekBar seekBar) {}
            @Override public void onStopTrackingTouch(SeekBar seekBar) {}
        });

        dialog.show();
    }

    private void showEditHostDialog(SshHost host) {
        Dialog dialog = new Dialog(this);
        dialog.setContentView(R.layout.dialog_edit_host);

        EditText editLabel = dialog.findViewById(R.id.editHostLabel);
        EditText editHost = dialog.findViewById(R.id.editHostAddress);
        EditText editPort = dialog.findViewById(R.id.editHostPort);
        EditText editUser = dialog.findViewById(R.id.editHostUser);
        EditText editPassword = dialog.findViewById(R.id.editHostPassword);
        EditText editGroup = dialog.findViewById(R.id.editHostGroup);
        RadioGroup radioGroupAuth = dialog.findViewById(R.id.radioGroupAuth);
        View containerPassword = dialog.findViewById(R.id.containerPassword);
        View containerKey = dialog.findViewById(R.id.containerKey);

        radioGroupAuth.setOnCheckedChangeListener((group, checkedId) -> {
            if (checkedId == R.id.radioAuthPassword) {
                containerPassword.setVisibility(View.VISIBLE);
                containerKey.setVisibility(View.GONE);
            } else {
                containerPassword.setVisibility(View.GONE);
                containerKey.setVisibility(View.VISIBLE);
            }
        });

        if (host != null) {
            editLabel.setText(host.getLabel());
            editHost.setText(host.getHost());
            editPort.setText(String.valueOf(host.getPort()));
            editUser.setText(host.getUsername());
            editGroup.setText(host.getGroup());
        }

        dialog.findViewById(R.id.btnCancelHost).setOnClickListener(v -> dialog.dismiss());
        dialog.findViewById(R.id.btnSaveHost).setOnClickListener(v -> {
            String label = editLabel.getText().toString();
            String address = editHost.getText().toString();
            int port = 22;
            try {
                port = Integer.parseInt(editPort.getText().toString());
            } catch (Exception ignored) {}
            String user = editUser.getText().toString();
            String pwd = editPassword.getText().toString();
            String grp = editGroup.getText().toString();

            if (host == null) {
                hostList.add(new SshHost(String.valueOf(System.currentTimeMillis()), label, address, port, user, "password", pwd, "", grp));
            }
            hostAdapter.notifyDataSetChanged();
            dialog.dismiss();
        });

        dialog.show();
    }

    private void showSnippetsDialog() {
        Dialog dialog = new Dialog(this);
        dialog.setContentView(R.layout.dialog_edit_snippet);
        dialog.findViewById(R.id.btnCancelSnippet).setOnClickListener(v -> dialog.dismiss());
        dialog.findViewById(R.id.btnSaveSnippet).setOnClickListener(v -> {
            EditText etTitle = dialog.findViewById(R.id.editSnippetTitle);
            EditText etGroup = dialog.findViewById(R.id.editSnippetGroup);
            EditText etCmd = dialog.findViewById(R.id.editSnippetCommand);
            String title = etTitle.getText().toString().trim();
            String group = etGroup.getText().toString().trim();
            String cmd = etCmd.getText().toString().trim();
            if (!title.isEmpty() && !cmd.isEmpty()) {
                snippetList.add(new Snippet(String.valueOf(System.currentTimeMillis()), title, cmd, group));
                Toast.makeText(this, "Snippet saved", Toast.LENGTH_SHORT).show();
            }
            dialog.dismiss();
        });
        dialog.show();
    }
}
