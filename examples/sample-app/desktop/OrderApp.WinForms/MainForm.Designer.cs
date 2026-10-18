namespace OrderApp.WinForms;

partial class MainForm
{
    private System.ComponentModel.IContainer components = null;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    #region Windows Form Designer generated code

    private void InitializeComponent()
    {
        this.header = new System.Windows.Forms.Label();
        this.screenHost = new System.Windows.Forms.Panel();
        this.SuspendLayout();
        //
        // header
        //
        this.header.BackColor = System.Drawing.Color.FromArgb(30, 58, 138);
        this.header.Dock = System.Windows.Forms.DockStyle.Top;
        this.header.Font = new System.Drawing.Font("Yu Gothic UI", 12F, System.Drawing.FontStyle.Bold);
        this.header.ForeColor = System.Drawing.Color.White;
        this.header.Location = new System.Drawing.Point(0, 0);
        this.header.Name = "header";
        this.header.Padding = new System.Windows.Forms.Padding(16, 0, 0, 0);
        this.header.Size = new System.Drawing.Size(624, 44);
        this.header.TabIndex = 0;
        this.header.Text = "注文受付";
        this.header.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
        //
        // screenHost
        //
        this.screenHost.Dock = System.Windows.Forms.DockStyle.Fill;
        this.screenHost.Location = new System.Drawing.Point(0, 44);
        this.screenHost.Name = "screenHost";
        this.screenHost.Padding = new System.Windows.Forms.Padding(16);
        this.screenHost.Size = new System.Drawing.Size(624, 397);
        this.screenHost.TabIndex = 1;
        //
        // MainForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(624, 441);
        this.Controls.Add(this.screenHost);
        this.Controls.Add(this.header);
        this.Font = new System.Drawing.Font("Yu Gothic UI", 9F);
        this.Name = "MainForm";
        this.StartPosition = System.Windows.Forms.FormStartPosition.CenterScreen;
        this.Text = "注文受付";
        this.ResumeLayout(false);
    }

    #endregion

    private System.Windows.Forms.Label header;
    private System.Windows.Forms.Panel screenHost;
}
